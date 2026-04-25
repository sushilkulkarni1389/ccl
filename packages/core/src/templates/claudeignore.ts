export const CLAUDEIGNORE_CONTENT = `# Dependencies
node_modules/
vendor/
.venv/
__pycache__/

# Build outputs
dist/
build/
out/
.next/
target/

# Logs
*.log
logs/

# Test fixtures & snapshots
__fixtures__/
__snapshots__/
*.snap

# Environment
.env
.env.local
.env.*.local

# OS
.DS_Store
Thumbs.db

# CCL internals (always excluded from Claude's context)
.claude/ccl-practices.json
.claude/ccl-state.json
`;

export function renderClaudeignore(): string {
  return CLAUDEIGNORE_CONTENT;
}
