// Static map from plugin-skill prefix (the part before the first `:` in a
// `plugin:skill-name` skill_name) to the plugin's GitHub repo, so the
// skills-invoked bars can link out to source instead of showing plain text.
//
// Empty until real GitHub URLs are known — unmapped prefixes render as plain
// text (see skillNameNode), never a guessed link, so an empty map is safe to
// ship. Add real entries here as they're confirmed, e.g.:
// ponytail: "https://github.com/<org>/ponytail",
export const PLUGIN_GITHUB_URLS: Record<string, string> = {};
