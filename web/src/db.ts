import type { Server } from './types';

const DB_NAME = 'copa';
const DB_VERSION = 2;
const STORE_SERVERS = 'servers';
const STORE_META = 'meta';

export function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_SERVERS)) {
        db.createObjectStore(STORE_SERVERS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db: IDBDatabase, stores: string | string[], mode: IDBTransactionMode) {
  return db.transaction(stores, mode);
}

export function getAllServers(db: IDBDatabase): Promise<Server[]> {
  return new Promise((resolve, reject) => {
    const req = tx(db, STORE_SERVERS, 'readonly').objectStore(STORE_SERVERS).getAll();
    req.onsuccess = () => resolve(req.result as Server[]);
    req.onerror = () => reject(req.error);
  });
}

export function putServer(db: IDBDatabase, server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = tx(db, STORE_SERVERS, 'readwrite').objectStore(STORE_SERVERS).put(server);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export function deleteServer(db: IDBDatabase, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = tx(db, STORE_SERVERS, 'readwrite').objectStore(STORE_SERVERS).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export function getActiveId(db: IDBDatabase): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const req = tx(db, STORE_META, 'readonly').objectStore(STORE_META).get('activeId');
    req.onsuccess = () => resolve(req.result as string | undefined);
    req.onerror = () => reject(req.error);
  });
}

export function setActiveId(db: IDBDatabase, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = tx(db, STORE_META, 'readwrite').objectStore(STORE_META).put(id, 'activeId');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export function clearActiveId(db: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = tx(db, STORE_META, 'readwrite').objectStore(STORE_META).delete('activeId');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
