/** Electron stores this namespace on disk; browser previews use their own origin storage. */
export const desktopStorage = {
  getItem(key: string): string | null {
    if (!window.alpha?.storage) return localStorage.getItem(key);
    const result = window.alpha.storage("getItem", key); if (result.error) throw new Error(result.error); return result.value ?? null;
  },
  setItem(key: string, value: string): void {
    if (!window.alpha?.storage) { localStorage.setItem(key, value); return; }
    const result = window.alpha.storage("setItem", key, value); if (result.error) throw new Error(result.error);
  },
  removeItem(key: string): void {
    if (!window.alpha?.storage) { localStorage.removeItem(key); return; }
    const result = window.alpha.storage("removeItem", key); if (result.error) throw new Error(result.error);
  },
};
