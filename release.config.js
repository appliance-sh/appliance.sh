/**
 * @type {import('semantic-release').GlobalConfig}
 */
module.exports = {
  branches: ["main"],
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    [
      "@semantic-release/github",
      {
        "assets": [
          {"path": ["packages/cli/dist/**/*.js", "packages/cli/package.json"], "label": "Appliance CLI"},
          {"path": ["packages/sdk/dist/**/*.js", "packages/sdk/package.json"], "label": "Appliance SDK"},
        ]
      }
    ],
    ["@semantic-release/exec", {
      "publishCmd": "echo \"publish_required=true\" >> \"$GITHUB_OUTPUT\""
    }],
  ],
};