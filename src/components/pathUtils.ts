// Path helpers shared by the file browser panels and the transfer engine.
// Kept separate from FilePanel so React Fast Refresh stays happy (a module that
// exports both a component and plain functions can't be hot-swapped cleanly).

/** Join/navigate a path with the given separator ('\\' local, '/' remote). */
export function joinPath(base: string, name: string, sep: string): string {
  if (name === '..') {
    const trimmed = base.replace(new RegExp(`${sep === '\\' ? '\\\\' : sep}+$`), '');
    const idx = trimmed.lastIndexOf(sep);
    // No separator left: on Windows go to the drive list (''), on POSIX to '/'.
    if (idx <= 0) return sep === '\\' ? '' : '/';
    const parent = trimmed.slice(0, idx);
    // Windows drive root: parent of "C:\Users" is "C:\", not "C:".
    if (sep === '\\' && /^[A-Za-z]:$/.test(parent)) return parent + '\\';
    return parent || (sep === '\\' ? '' : '/');
  }
  if (!base) return name; // windows drive root list -> pick a drive
  return base.endsWith(sep) ? base + name : base + sep + name;
}
