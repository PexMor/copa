/// Trusted token issuers: configuration, validation and — added in the following
/// modules — JWT verification and claim → permission mapping.
///
/// copasrv never performs an OAuth exchange and never sees refresh tokens: it only
/// verifies access tokens (JWTs) signed by an issuer the operator configured.
use super::config::{ClaimRule, IssuerConfig};
use super::jwks::Jwks;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use jsonwebtoken::{decode, decode_header, errors::ErrorKind, Algorithm, DecodingKey, Validation};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

pub const DEFAULT_ALGORITHMS: [&str; 2] = ["ES256", "RS256"];
pub const DEFAULT_LEEWAY_SECS: u64 = 30;
pub const MAX_LEEWAY_SECS: u64 = 300;
pub const DEFAULT_JWKS_TTL_SECS: u64 = 600;
pub const DEFAULT_JWKS_MIN_REFRESH_SECS: u64 = 10;

/// What a matched rule grants.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    R,
    W,
    Rw,
}

impl Access {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "r" => Some(Access::R),
            "w" => Some(Access::W),
            "rw" => Some(Access::Rw),
            _ => None,
        }
    }
    pub fn read(self) -> bool {
        matches!(self, Access::R | Access::Rw)
    }
    pub fn write(self) -> bool {
        matches!(self, Access::W | Access::Rw)
    }
}

#[derive(Debug, Clone)]
pub struct Rule {
    pub claim:     String,
    pub value:     String,
    pub namespace: String,
    pub access:    Access,
}

/// A validated issuer entry.
#[derive(Debug, Clone)]
pub struct IssuerSpec {
    pub name:              String,
    pub iss:               String,
    pub jwks_url:          String,
    pub audience:          String,
    pub algorithms:        Vec<Algorithm>,
    pub leeway_ms:         u64,
    pub jwks_ttl:          Duration,
    pub jwks_min_refresh:  Duration,
    pub rules:             Vec<Rule>,
}

/// Only asymmetric algorithms: with a shared secret, everyone able to verify could also mint tokens.
pub fn parse_algorithm(name: &str) -> Result<Algorithm, String> {
    match name {
        "ES256" => Ok(Algorithm::ES256),
        "ES384" => Ok(Algorithm::ES384),
        "RS256" => Ok(Algorithm::RS256),
        "RS384" => Ok(Algorithm::RS384),
        "RS512" => Ok(Algorithm::RS512),
        "PS256" => Ok(Algorithm::PS256),
        "PS384" => Ok(Algorithm::PS384),
        "PS512" => Ok(Algorithm::PS512),
        "EdDSA" => Ok(Algorithm::EdDSA),
        "HS256" | "HS384" | "HS512" => Err(format!(
            "{name} is not allowed: symmetric algorithms would let anyone who can verify a token also forge one"
        )),
        "none" | "None" | "NONE" => Err("alg none (unsigned tokens) is never allowed".to_owned()),
        other => Err(format!(
            "unknown algorithm {other:?}; allowed: ES256, ES384, RS256, RS384, RS512, PS256, PS384, PS512, EdDSA"
        )),
    }
}

fn is_loopback_host(host: &str) -> bool {
    let h = host.trim_start_matches('[').trim_end_matches(']');
    h == "localhost" || h.ends_with(".localhost") || h == "::1" || h.parse::<std::net::Ipv4Addr>().is_ok_and(|ip| ip.is_loopback())
}

fn check_jwks_url(raw: &str) -> Result<(), String> {
    let u = url::Url::parse(raw).map_err(|e| format!("jwks_url {raw:?} is not a valid URL: {e}"))?;
    match (u.scheme(), u.host_str()) {
        (_, None) => Err(format!("jwks_url {raw:?} has no host")),
        ("https", _) => Ok(()),
        ("http", Some(h)) if is_loopback_host(h) => Ok(()),
        _ => Err(format!("jwks_url {raw:?} must use https (http is only accepted for loopback hosts)")),
    }
}

fn validate_one(name: &str, c: &IssuerConfig, namespaces: &HashSet<String>) -> Result<IssuerSpec, String> {
    if c.iss.trim().is_empty() {
        return Err("iss must not be empty".into());
    }
    if c.audience.trim().is_empty() {
        return Err("audience must not be empty (it ties tokens to this server)".into());
    }
    check_jwks_url(&c.jwks_url)?;

    let names: Vec<String> = c
        .algorithms
        .clone()
        .unwrap_or_else(|| DEFAULT_ALGORITHMS.iter().map(|s| (*s).to_owned()).collect());
    if names.is_empty() {
        return Err("algorithms must not be empty".into());
    }
    let algorithms = names.iter().map(|n| parse_algorithm(n)).collect::<Result<Vec<_>, _>>()?;

    let leeway = c.leeway_secs.unwrap_or(DEFAULT_LEEWAY_SECS);
    if leeway > MAX_LEEWAY_SECS {
        return Err(format!("leeway_secs must be at most {MAX_LEEWAY_SECS} (got {leeway})"));
    }
    let ttl = c.jwks_ttl_secs.unwrap_or(DEFAULT_JWKS_TTL_SECS);
    if ttl == 0 {
        return Err("jwks_ttl_secs must be greater than 0".into());
    }

    if c.map.is_empty() {
        return Err("map must contain at least one rule (an issuer without rules grants nothing)".into());
    }
    let mut rules = Vec::new();
    for (i, r) in c.map.iter().enumerate() {
        rules.push(validate_rule(i, r, namespaces)?);
    }

    Ok(IssuerSpec {
        name: name.to_owned(),
        iss: c.iss.clone(),
        jwks_url: c.jwks_url.clone(),
        audience: c.audience.clone(),
        algorithms,
        leeway_ms: leeway * 1000,
        jwks_ttl: Duration::from_secs(ttl),
        jwks_min_refresh: Duration::from_secs(c.jwks_min_refresh_secs.unwrap_or(DEFAULT_JWKS_MIN_REFRESH_SECS)),
        rules,
    })
}

fn validate_rule(i: usize, r: &ClaimRule, namespaces: &HashSet<String>) -> Result<Rule, String> {
    let at = format!("map[{i}]");
    if r.claim.trim().is_empty() {
        return Err(format!("{at}.claim must not be empty"));
    }
    if r.value.is_empty() {
        return Err(format!("{at}.value must not be empty"));
    }
    let access = Access::parse(&r.access)
        .ok_or_else(|| format!("{at}.access must be \"r\", \"w\" or \"rw\" (got {:?})", r.access))?;
    if !namespaces.contains(&r.namespace) {
        return Err(format!("{at}.namespace {:?} is not a configured namespace", r.namespace));
    }
    Ok(Rule { claim: r.claim.clone(), value: r.value.clone(), namespace: r.namespace.clone(), access })
}

/// Validate every `[server.auth.issuers.*]` entry; the error names the entry and the problem.
pub fn validate(
    issuers: &HashMap<String, IssuerConfig>,
    namespaces: &HashSet<String>,
) -> Result<Vec<IssuerSpec>, String> {
    let mut names: Vec<&String> = issuers.keys().collect();
    names.sort();
    let mut seen: HashMap<&str, &str> = HashMap::new();
    let mut out = Vec::new();
    for name in names {
        let cfg = &issuers[name];
        let spec = validate_one(name, cfg, namespaces).map_err(|e| format!("[server.auth.issuers.{name}]: {e}"))?;
        if let Some(other) = seen.insert(&cfg.iss, name) {
            return Err(format!(
                "[server.auth.issuers.{name}]: iss {:?} is already used by [server.auth.issuers.{other}]",
                cfg.iss
            ));
        }
        out.push(spec);
    }
    Ok(out)
}

// ── Verification ──────────────────────────────────────────────────────────────

/// Why a token from (or claiming to be from) an issuer was refused. Never carries token text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reject {
    Malformed,
    UnknownIssuer(String),
    /// Algorithm missing from the issuer's allow-list, unsupported (`none`) or symmetric.
    Algorithm(String),
    /// No key with that `kid` is published (or the key set is unavailable).
    NoKey,
    Signature,
    Expired,
    NotYetValid,
    /// `aud` / `iss` / a required claim is wrong or missing.
    Claim(String),
}

impl std::fmt::Display for Reject {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Reject::Malformed => f.write_str("malformed token"),
            Reject::UnknownIssuer(iss) => write!(f, "unknown issuer {iss:?}"),
            Reject::Algorithm(a) => write!(f, "algorithm {a:?} not allowed"),
            Reject::NoKey => f.write_str("no matching signing key"),
            Reject::Signature => f.write_str("signature does not verify"),
            Reject::Expired => f.write_str("token expired"),
            Reject::NotYetValid => f.write_str("token not yet valid"),
            Reject::Claim(c) => write!(f, "claim check failed: {c}"),
        }
    }
}

/// A token that passed every check; `claims` are trustworthy.
#[derive(Debug, Clone)]
pub struct Verified {
    /// Name of the `[server.auth.issuers.<name>]` entry.
    pub issuer: String,
    pub claims: Value,
    /// Unix ms at which the token expires.
    pub exp_ms: u64,
}

/// Outcome of resolving a bearer token against the trusted issuers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// Valid token; grants these permissions in the requested namespace.
    Granted { read: bool, write: bool, exp_ms: u64 },
    /// Valid token, but no mapping rule applies to the requested namespace (→ 403).
    NoMapping { exp_ms: u64 },
    Rejected(Reject),
}

/// Printable-ASCII, length-capped rendering of attacker-controlled text for logs.
fn loggable(s: &str) -> String {
    s.chars().take(80).map(|c| if c.is_ascii_graphic() || c == ' ' { c } else { '?' }).collect()
}

/// Whether a bearer value has the shape of a JWT: three dot-separated parts (header and payload
/// non-empty; an empty signature is allowed so unsigned `alg: none` tokens get a proper rejection),
/// and not a device token.
pub fn looks_like_jwt(tok: &str) -> bool {
    let parts: Vec<&str> = tok.split('.').collect();
    !tok.starts_with(super::token::PREFIX) && parts.len() == 3 && !parts[0].is_empty() && !parts[1].is_empty()
}

/// `*` matches any (possibly empty) run of characters; everything else is literal.
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti, mut star, mut mark) = (0usize, 0usize, None::<usize>, 0usize);
    while ti < t.len() {
        if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if pi < p.len() && p[pi] == t[ti] {
            pi += 1;
            ti += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// Claim by exact name first (names such as `https://x/roles` contain dots), then as a dotted path.
fn claim<'a>(claims: &'a Value, name: &str) -> Option<&'a Value> {
    if let Some(v) = claims.get(name) {
        return Some(v);
    }
    name.split('.').try_fold(claims, |v, part| v.get(part))
}

fn value_matches(v: &Value, pattern: &str, split_scopes: bool) -> bool {
    match v {
        Value::String(s) => {
            if split_scopes {
                s.split_whitespace().any(|part| glob_match(pattern, part))
            } else {
                glob_match(pattern, s)
            }
        }
        Value::Array(items) => items.iter().any(|i| value_matches(i, pattern, false)),
        Value::Bool(b) => glob_match(pattern, &b.to_string()),
        Value::Number(n) => glob_match(pattern, &n.to_string()),
        _ => false,
    }
}

/// Does `rule` apply to a token with these claims? `scope`/`scp` are space-separated lists.
pub fn rule_matches(claims: &Value, rule: &Rule) -> bool {
    let split = matches!(rule.claim.as_str(), "scope" | "scp");
    claim(claims, &rule.claim).is_some_and(|v| value_matches(v, &rule.value, split))
}

pub struct Issuer {
    pub spec: IssuerSpec,
    jwks:     Jwks,
}

/// All trusted issuers of this server.
pub struct IssuerSet {
    issuers: Vec<Issuer>,
}

impl IssuerSet {
    /// Keys are fetched over HTTP(S) when first needed.
    pub fn new(specs: Vec<IssuerSpec>) -> Self {
        Self::with_jwks(specs, |s| Jwks::over_http(&s.name, &s.jwks_url, s.jwks_ttl, s.jwks_min_refresh))
    }

    pub fn with_jwks(specs: Vec<IssuerSpec>, make: impl Fn(&IssuerSpec) -> Jwks) -> Self {
        Self { issuers: specs.into_iter().map(|spec| Issuer { jwks: make(&spec), spec }).collect() }
    }

    pub fn is_empty(&self) -> bool {
        self.issuers.is_empty()
    }

    /// The token's own `iss` is only used to *select* a configured issuer; nothing in the
    /// token is trusted until its signature verified against that issuer's keys.
    /// The header's `alg` as written, for diagnostics only.
    fn raw_alg(token: &str) -> Option<String> {
        let raw = B64.decode(token.split('.').next()?).ok()?;
        serde_json::from_slice::<Value>(&raw).ok()?.get("alg")?.as_str().map(str::to_owned)
    }

    fn peek_iss(token: &str) -> Option<String> {
        let payload = token.split('.').nth(1)?;
        let raw = B64.decode(payload).ok()?;
        serde_json::from_slice::<Value>(&raw).ok()?.get("iss")?.as_str().map(str::to_owned)
    }

    pub fn verify(&self, token: &str, now_ms: u64) -> Result<Verified, Reject> {
        let header = decode_header(token).map_err(|e| match e.kind() {
            ErrorKind::InvalidAlgorithmName | ErrorKind::InvalidAlgorithm => Reject::Algorithm("unsupported".into()),
            // `alg: none` (and other names jsonwebtoken cannot represent) fail to parse: say which.
            _ => Self::raw_alg(token).map_or(Reject::Malformed, |a| Reject::Algorithm(loggable(&a))),
        })?;
        let iss = Self::peek_iss(token).ok_or(Reject::Malformed)?;
        let issuer = self
            .issuers
            .iter()
            .find(|i| i.spec.iss == iss)
            .ok_or_else(|| Reject::UnknownIssuer(loggable(&iss)))?;
        let spec = &issuer.spec;

        if !spec.algorithms.contains(&header.alg) {
            return Err(Reject::Algorithm(format!("{:?}", header.alg)));
        }
        let jwk = issuer.jwks.key(header.kid.as_deref()).ok_or(Reject::NoKey)?;
        let key = DecodingKey::from_jwk(&jwk).map_err(|_| Reject::NoKey)?;

        // Signature, issuer and audience here; exp/nbf below against the server's own clock.
        let mut v = Validation::new(header.alg);
        v.algorithms = vec![header.alg];
        v.validate_exp = false;
        v.validate_nbf = false;
        v.leeway = 0;
        v.set_issuer(&[spec.iss.as_str()]);
        v.set_audience(&[spec.audience.as_str()]);
        v.required_spec_claims = ["exp", "iss", "aud"].into_iter().map(String::from).collect();
        let data = decode::<Value>(token, &key, &v).map_err(|e| match e.kind() {
            ErrorKind::InvalidSignature => Reject::Signature,
            ErrorKind::InvalidAudience => Reject::Claim("aud".into()),
            ErrorKind::InvalidIssuer => Reject::Claim("iss".into()),
            ErrorKind::MissingRequiredClaim(c) => Reject::Claim(format!("{c} missing")),
            ErrorKind::InvalidAlgorithm | ErrorKind::InvalidKeyFormat => Reject::Signature,
            _ => Reject::Malformed,
        })?;
        let claims = data.claims;

        let exp_ms = claims
            .get("exp")
            .and_then(Value::as_f64)
            .filter(|e| e.is_finite() && *e > 0.0)
            .map(|e| (e * 1000.0) as u64)
            .ok_or_else(|| Reject::Claim("exp is not a number".into()))?;
        if now_ms >= exp_ms.saturating_add(spec.leeway_ms) {
            return Err(Reject::Expired);
        }
        if let Some(nbf) = claims.get("nbf").and_then(Value::as_f64) {
            if (nbf * 1000.0) as u64 > now_ms.saturating_add(spec.leeway_ms) {
                return Err(Reject::NotYetValid);
            }
        }
        Ok(Verified { issuer: spec.name.clone(), claims, exp_ms })
    }

    /// Verify `token` and compute what it grants in namespace `ns`.
    pub fn decide(&self, ns: &str, token: &str, now_ms: u64) -> Decision {
        let verified = match self.verify(token, now_ms) {
            Ok(v) => v,
            Err(r) => return Decision::Rejected(r),
        };
        let spec = &self.issuers.iter().find(|i| i.spec.name == verified.issuer).expect("issuer exists").spec;
        let (mut read, mut write, mut any) = (false, false, false);
        for rule in spec.rules.iter().filter(|r| r.namespace == ns) {
            if rule_matches(&verified.claims, rule) {
                any = true;
                read |= rule.access.read();
                write |= rule.access.write();
            }
        }
        if any {
            Decision::Granted { read, write, exp_ms: verified.exp_ms }
        } else {
            Decision::NoMapping { exp_ms: verified.exp_ms }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(ns: &str) -> ClaimRule {
        ClaimRule { claim: "scope".into(), value: "copa:team:rw".into(), namespace: ns.into(), access: "rw".into() }
    }

    fn cfg() -> IssuerConfig {
        IssuerConfig {
            iss: "https://auth.example.com".into(),
            jwks_url: "https://auth.example.com/jwks.json".into(),
            audience: "https://copa.example.com".into(),
            algorithms: None,
            leeway_secs: None,
            jwks_ttl_secs: None,
            jwks_min_refresh_secs: None,
            map: vec![rule("team")],
        }
    }

    fn namespaces() -> HashSet<String> {
        ["team".to_owned(), "default".to_owned()].into()
    }

    fn check(c: IssuerConfig) -> Result<IssuerSpec, String> {
        let m = HashMap::from([("hub".to_owned(), c)]);
        validate(&m, &namespaces()).map(|mut v| v.remove(0))
    }

    fn err(c: IssuerConfig) -> String {
        check(c).unwrap_err()
    }

    #[test]
    fn a_complete_entry_is_accepted_with_defaults() {
        let s = check(cfg()).unwrap();
        assert_eq!(s.algorithms, vec![Algorithm::ES256, Algorithm::RS256]);
        assert_eq!((s.leeway_ms, s.jwks_ttl.as_secs(), s.jwks_min_refresh.as_secs()), (30_000, 600, 10));
        assert_eq!(s.rules.len(), 1);
        assert_eq!(s.rules[0].access, Access::Rw);
    }

    #[test]
    fn it_parses_from_toml() {
        let src = r#"
[server.auth.issuers.hub]
iss = "https://auth.example.com"
jwks_url = "https://auth.example.com/jwks.json"
audience = "https://copa.example.com"
algorithms = ["ES256"]
leeway_secs = 5
[[server.auth.issuers.hub.map]]
claim = "groups"
value = "copa-readers"
namespace = "team"
access = "r"
[[server.auth.issuers.hub.map]]
claim = "scope"
value = "copa:team:rw"
namespace = "team"
access = "rw"
"#;
        let cfg: crate::server::config::ConfigFile = toml::from_str(src).unwrap();
        let issuers = cfg.server.auth.unwrap().issuers;
        let spec = validate(&issuers, &namespaces()).unwrap().remove(0);
        assert_eq!(spec.name, "hub");
        assert_eq!((spec.algorithms.as_slice(), spec.leeway_ms, spec.rules.len()), (&[Algorithm::ES256][..], 5_000, 2));
    }

    #[test]
    fn errors_name_the_entry_and_the_problem() {
        let mut c = cfg();
        c.audience = String::new();
        let e = err(c);
        assert!(e.starts_with("[server.auth.issuers.hub]:") && e.contains("audience"), "{e}");
    }

    #[test]
    fn empty_iss_and_audience_are_refused() {
        for (iss, aud) in [("", "a"), ("  ", "a"), ("i", ""), ("i", " ")] {
            let mut c = cfg();
            c.iss = iss.into();
            c.audience = aud.into();
            assert!(check(c).is_err(), "{iss:?} {aud:?}");
        }
    }

    #[test]
    fn symmetric_algorithms_and_none_are_refused_with_a_reason() {
        for bad in ["HS256", "HS384", "HS512"] {
            let mut c = cfg();
            c.algorithms = Some(vec!["ES256".into(), bad.into()]);
            let e = err(c);
            assert!(e.contains(bad) && e.contains("symmetric"), "{e}");
        }
        for bad in ["none", "None", "NONE"] {
            let mut c = cfg();
            c.algorithms = Some(vec![bad.into()]);
            assert!(err(c).contains("never allowed"));
        }
    }

    #[test]
    fn unknown_and_empty_algorithm_lists_are_refused() {
        let mut c = cfg();
        c.algorithms = Some(vec!["ROT13".into()]);
        assert!(err(c).contains("unknown algorithm"));
        let mut c = cfg();
        c.algorithms = Some(vec![]);
        assert!(err(c).contains("must not be empty"));
    }

    #[test]
    fn every_asymmetric_algorithm_is_accepted() {
        let mut c = cfg();
        c.algorithms = Some(["ES256", "ES384", "RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "EdDSA"].map(String::from).to_vec());
        assert_eq!(check(c).unwrap().algorithms.len(), 9);
    }

    #[test]
    fn jwks_url_must_be_https_or_loopback_http() {
        for ok in ["https://a.example/jwks", "http://127.0.0.1:8090/jwks.json", "http://localhost/jwks", "http://[::1]:1/j"] {
            let mut c = cfg();
            c.jwks_url = ok.into();
            assert!(check(c).is_ok(), "{ok}");
        }
        for bad in ["http://auth.example.com/jwks", "ftp://a/b", "auth.example.com/jwks", "https://", "", "http://127.0.0.1.evil.com/j"] {
            let mut c = cfg();
            c.jwks_url = bad.into();
            assert!(check(c).is_err(), "{bad}");
        }
    }

    #[test]
    fn leeway_and_ttl_limits() {
        let mut c = cfg();
        c.leeway_secs = Some(301);
        assert!(err(c).contains("leeway_secs"));
        let mut c = cfg();
        c.leeway_secs = Some(300);
        assert!(check(c).is_ok());
        let mut c = cfg();
        c.jwks_ttl_secs = Some(0);
        assert!(err(c).contains("jwks_ttl_secs"));
    }

    #[test]
    fn rules_are_required_and_checked() {
        let mut c = cfg();
        c.map.clear();
        assert!(err(c).contains("at least one rule"));

        for (field, bad) in [("claim", ""), ("value", ""), ("access", "x"), ("access", "RW"), ("namespace", "nope")] {
            let mut c = cfg();
            match field {
                "claim" => c.map[0].claim = bad.into(),
                "value" => c.map[0].value = bad.into(),
                "access" => c.map[0].access = bad.into(),
                _ => c.map[0].namespace = bad.into(),
            }
            let e = err(c);
            assert!(e.contains("map[0]") && e.contains(field), "{field}: {e}");
        }
    }

    #[test]
    fn the_same_iss_cannot_be_configured_twice() {
        let m = HashMap::from([("a".to_owned(), cfg()), ("b".to_owned(), cfg())]);
        let e = validate(&m, &namespaces()).unwrap_err();
        assert!(e.contains("already used"), "{e}");
    }

    #[test]
    fn several_distinct_issuers_are_fine() {
        let mut other = cfg();
        other.iss = "https://other.example".into();
        let m = HashMap::from([("a".to_owned(), cfg()), ("b".to_owned(), other)]);
        assert_eq!(validate(&m, &namespaces()).unwrap().len(), 2);
    }

    #[test]
    fn glob_matching() {
        for (p, t, ok) in [
            ("copa:team:rw", "copa:team:rw", true),
            ("copa:team:rw", "copa:team:r", false),
            ("*@example.com", "dana@example.com", true),
            ("*@example.com", "dana@example.com.evil", false),
            ("copa:*:r", "copa:team:r", true),
            ("copa:*:r", "copa:team:rw", false),
            ("*", "", true),
            ("*", "anything", true),
            ("a*b*c", "aXXbYYc", true),
            ("a*b*c", "aXXbYY", false),
            ("**x", "x", true),
            ("", "", true),
            ("", "x", false),
            ("x", "", false),
            ("é*", "éa", true),
        ] {
            assert_eq!(glob_match(p, t), ok, "{p:?} vs {t:?}");
        }
    }

    fn rule_for(claim: &str, value: &str) -> Rule {
        Rule { claim: claim.into(), value: value.into(), namespace: "team".into(), access: Access::R }
    }

    #[test]
    fn rules_match_scope_lists_arrays_strings_and_paths() {
        let claims = serde_json::json!({
            "scope": "openid copa:team:rw email",
            "scp": "copa:team:r other",
            "groups": ["copa-readers", "staff"],
            "email": "dana@example.com",
            "realm_access": { "roles": ["copa-admin"] },
            "https://example.com/roles": ["x"],
            "level": 3,
            "active": true,
        });
        let yes = |c: &str, v: &str| assert!(rule_matches(&claims, &rule_for(c, v)), "{c}={v}");
        let no = |c: &str, v: &str| assert!(!rule_matches(&claims, &rule_for(c, v)), "{c}={v}");
        yes("scope", "copa:team:rw");        // one element of a space-separated list
        yes("scope", "copa:*");
        no("scope", "copa:team");            // whole-element matching, not substring
        no("scope", "copa:team:rw email");   // a scope never contains a space
        yes("scp", "other");                 // `scp` is split like `scope`
        yes("groups", "copa-readers");
        yes("groups", "copa-*");
        no("groups", "copa");
        yes("email", "*@example.com");
        no("email", "*@other.com");
        yes("realm_access.roles", "copa-admin");   // dotted path
        yes("https://example.com/roles", "x");     // claim names that contain dots
        yes("level", "3");
        yes("active", "true");
        no("missing", "x");
        no("realm_access", "copa-admin");          // an object never matches
    }

    #[test]
    fn a_string_claim_that_is_not_scope_is_not_split_on_spaces() {
        let claims = serde_json::json!({ "name": "Dana Admin", "scope": "a b" });
        assert!(rule_matches(&claims, &rule_for("name", "Dana Admin")));
        assert!(!rule_matches(&claims, &rule_for("name", "Dana")));
        assert!(rule_matches(&claims, &rule_for("scope", "b")));
    }

    #[test]
    fn jwt_shape_detection() {
        assert!(looks_like_jwt("aaa.bbb.ccc"));
        assert!(looks_like_jwt("aaa.bbb."), "unsigned tokens are routed to verification, which refuses them");
        for no in ["", "abc", "a.b", "a.b.c.d", "v1.a.b", "a..c", ".b.c"] {
            assert!(!looks_like_jwt(no), "{no:?}");
        }
    }

    #[test]
    fn log_rendering_of_hostile_text_is_safe() {
        let hostile = format!("evil\n\x1b[31m{}", "x".repeat(500));
        let l = loggable(&hostile);
        assert!(l.len() <= 80 && !l.contains('\n') && !l.contains('\x1b'));
    }

    #[test]
    fn access_flags() {
        assert_eq!((Access::R.read(), Access::R.write()), (true, false));
        assert_eq!((Access::W.read(), Access::W.write()), (false, true));
        assert_eq!((Access::Rw.read(), Access::Rw.write()), (true, true));
    }
}
