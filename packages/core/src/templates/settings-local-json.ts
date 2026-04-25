// Renders an empty settings.local.json — machine-local overrides only.
// Always gitignored regardless of gitSync choice (§8.3).
export function renderSettingsLocalJson(): string {
  return "{}\n";
}
