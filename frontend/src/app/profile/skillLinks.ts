// Static map from plugin-skill prefix (the part before the first `:` in a
// `plugin:skill-name` skill_name) to the plugin's GitHub repo, so the
// skills-invoked bars can link out to source instead of showing plain text.
//
// Placeholder URLs — these are not real repo links yet. Fill in the actual
// GitHub URLs before shipping this to users.
export const PLUGIN_GITHUB_URLS: Record<string, string> = {
  ponytail: "https://github.com/REPLACE_ME/ponytail",
  impeccable: "https://github.com/REPLACE_ME/impeccable",
  superpowers: "https://github.com/REPLACE_ME/superpowers",
};
