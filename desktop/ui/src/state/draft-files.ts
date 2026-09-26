function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("alpha-draft-files", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("drafts");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadDraftFiles(key: string): Promise<File[]> {
  const db = await database();
  try {
    return await new Promise<File[]>((resolve, reject) => {
      const request = db.transaction("drafts", "readonly").objectStore("drafts").get(key);
      request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result as File[] : []);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

export async function saveDraftFiles(key: string, files: File[]): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("drafts", "readwrite");
      transaction.objectStore("drafts").put(files, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally { db.close(); }
}
