export function newAccountId(): string {
  return `acct_${Math.random().toString(36).slice(2, 10)}`;
}

export function maskKey(key: string): string {
  const value = key.trim();
  if (value.length <= 10) return "••••";
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
