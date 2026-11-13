import { useEffect, useState } from 'preact/hooks';
import { getAccessEpoch, subscribeRestored } from '../utils/access';

/**
 * Changes value each time an expired identity-proxy session becomes valid
 * again. Put it in an effect's dependency list to restart that effect's
 * networking after the user signed in, without a page reload.
 */
export function useAccessEpoch(): number {
  const [epoch, setEpoch] = useState(getAccessEpoch());
  useEffect(() => subscribeRestored(setEpoch), []);
  return epoch;
}
