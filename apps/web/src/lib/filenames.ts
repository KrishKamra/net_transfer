/**
 * STOR is `STOR <filename> <size>`. The size is the last field, so the name
 * may contain spaces. Slashes and `..` are still rejected by the sandbox.
 */
export function storFilenameError(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..') {
    return 'This file needs a name before it can be stored.'
  }
  if (/[\\/\r\n]/.test(trimmed) || trimmed.includes('..')) {
    return 'This name has a path character. Rename the file and upload it again.'
  }
  return null
}
