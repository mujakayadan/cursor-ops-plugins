import { bool, obj, oneOf, str, tool } from "./lib/core/schema-helpers.ts";
import type { Provider } from "./lib/core/types.ts";
import { SYSTEMS, type System } from "./sources.ts";
import { vetPackage, vetProject } from "./vet.ts";

const system = oneOf(
  Object.keys(SYSTEMS) as System[],
  "Package system: npm, pypi, maven (group:artifact), cargo, go, nuget or rubygems.",
);
const packageName = str("Package name as its registry spells it, such as @tanstack/query-core.", {
  pattern: "^[A-Za-z0-9@][A-Za-z0-9@._/:~+-]{0,213}$",
});
const version = str("Exact version; omit for the default (latest stable) version.", {
  pattern: "^[A-Za-z0-9][A-Za-z0-9._+~:-]{0,99}$",
});
const project = str(
  "Repository as github.com/<owner>/<repo> (gitlab.com and bitbucket.org work too).",
  {
    pattern:
      "^(?:github\\.com|gitlab\\.com|bitbucket\\.org)/[A-Za-z0-9._-]{1,100}/[A-Za-z0-9._-]{1,100}$",
  },
);

const tools = [
  tool({
    name: "oss_package",
    title: "Vet a package",
    tier: "read",
    description:
      "Vet an open-source package version from public data (deps.dev, OSV, OpenSSF Scorecard): license and its class (permissive, weak-copyleft, strong-copyleft, restrictive, unknown), release cadence, deprecation, provenance attestations, advisories with CVSS, the source repository's stars and Scorecard, and the resolved dependency graph with every dependency version that has known advisories (npm, pypi, maven, cargo). `flags` lists the concerns to weigh.",
    input: obj(
      {
        system,
        name: packageName,
        version,
        dependencies: bool("Resolve the dependency graph and check every node against OSV.", true),
      },
      ["system", "name"],
    ),
    run: (a) => vetPackage(a.system, a.name, a.version, a.dependencies),
  }),
  tool({
    name: "oss_project",
    title: "Vet a repository",
    tier: "read",
    description:
      "Vet an open-source repository from public data: stars, forks, open issues, license, OSS-Fuzz coverage, every OpenSSF Scorecard check with its reason, and the packages published from it. `flags` lists the concerns to weigh. Use ops-github tools for activity (recent commits, releases, contributors).",
    input: obj({ project }, ["project"]),
    run: (a) => vetProject(a.project),
  }),
];

const provider: Provider = {
  id: "oss",
  displayName: "Open Source",
  version: "1.0.0",
  bin: "node",
  instructions: {
    read: "Vets open-source packages and repositories from public data (deps.dev, OSV, OpenSSF Scorecard): licenses, maintenance, provenance, advisories and vulnerable dependencies.",
    write: "No write tools; vetting is read-only.",
  },
  tools,
};

export default provider;
