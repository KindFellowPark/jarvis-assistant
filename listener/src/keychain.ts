// Reads one secret from the macOS Keychain at the moment it is needed. Nothing is cached.
export function keychain(service: string): string {
  const res = Bun.spawnSync(["security", "find-generic-password", "-s", service, "-w"]);
  const value = res.stdout.toString().trim();
  if (res.exitCode !== 0 || !value) throw new Error(`Keychain item ${service} is missing`);
  return value;
}
