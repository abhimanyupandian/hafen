// A provider's fixtures, as its file writes them (contracts/provider.md, Fixtures): on its own, with
// nothing heavy imported, so the app's page can read them too (the Fixtures field).
//
// By when they run, each list in its order:
//   fixtures: { beforeAll: [acme-login], before: [reset-cart], after: [], afterAll: [acme-logout] }
// → { beforeAll: [{ name, range, entry }], before, after, afterAll, problems: [messages], at: [paths],
// duplicates: [{ phase, name, message }] }. A name may take a version range (acme-login@^1). A list
// names each fixture once: twice (acme-login, acme-login@^1) is a problem, and in `duplicates` too, so
// the app can still show the list and take the extra out. Another list can name it again (a fixture
// before each test and after it). `at` has each problem's place in the provider, in the same order
// (["fixtures", "before", 1]), so a check can say its line.
export const FIXTURE_PHASES = ["beforeAll", "before", "after", "afterAll"];
export function fixturesOf(config) {
  const out = { beforeAll: [], before: [], after: [], afterAll: [], problems: [], at: [], duplicates: [] };
  const problem = (message, path) => {
    out.problems.push(message);
    out.at.push(path);
  };
  const lists = config?.fixtures;
  if (lists === undefined || lists === null) return out;
  if (typeof lists !== "object" || Array.isArray(lists)) {
    problem("a provider's fixtures is a map of lists: { beforeAll: [], before: [], after: [], afterAll: [] }", ["fixtures"]);
    return out;
  }
  for (const [phase, list] of Object.entries(lists)) {
    const bad = Array.isArray(list) ? list.findIndex((n) => typeof n !== "string" || !/^[^@\s]+(@\S+)?$/.test(n.trim())) : -1;
    if (!FIXTURE_PHASES.includes(phase)) problem(`fixtures has no list "${phase}": its lists are beforeAll, before, after and afterAll`, ["fixtures", phase]);
    else if (!Array.isArray(list) || bad !== -1) problem(`fixtures.${phase} is a list of fixture plugins' names`, ["fixtures", phase, ...(bad !== -1 ? [bad] : [])]);
    else {
      out[phase] = list.map((entry) => { const [, name, range] = entry.trim().match(/^([^@]+)(?:@(.+))?$/); return { name, range, entry }; });
      const seen = new Set();
      for (const [i, { name }] of out[phase].entries()) {
        if (seen.has(name) && !out.duplicates.some((d) => d.phase === phase && d.name === name)) {
          const message = `fixtures.${phase} names ${name} twice: a list runs each fixture once (another list can name it too)`;
          out.duplicates.push({ phase, name, message });
          problem(message, ["fixtures", phase, i]);
        }
        seen.add(name);
      }
    }
  }
  return out;
}
