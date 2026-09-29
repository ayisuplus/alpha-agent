import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotExpert, ExpertStore } from "../src/runtime/experts";
import { resolveExpertScope } from "../src/runtime/expert-scope";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "alpha-expert-scope-"));
  const pack = join(root, "plugin-packs", "sample");
  for (const [id, body] of [["proof", "Verify the claim."], ["guide", "Follow the guide."], ["extra", "Extra material."]] as const) {
    await mkdir(join(pack, "skills", id), { recursive: true });
    await writeFile(join(pack, "skills", id, "SKILL.md"), `---\nname: ${id}\ndescription: ${body}\n---\n\n${body}\n`);
  }
  await writeFile(join(root, "plugin-packs", "installed.json"), JSON.stringify({ plugins: [{ id: "sample", name: "sample", source: "https://github.com/a/sample.git", revision: "a".repeat(40), enabled: true, skillCount: 3, hookCount: 0, hooksEnabled: false, mcpCount: 0, mcpEnabled: false }] }));
  return root;
}

test("activation mounts the persona, injects the primary method and records each Skill's source", async () => {
  const root = await fixture();
  try {
    const store = new ExpertStore(root);
    const created = await store.create({
      name: "Evidence reviewer", description: "Review changes", instructions: "Check concrete evidence.",
      skillIds: ["sample:proof", "sample:guide"],
      mounts: { skills: ["sample:proof", "sample:guide"], primarySkill: "sample:proof", mcp: [] },
    });
    const scope = await resolveExpertScope({ expert: snapshotExpert(created), host: "coordinator", access: "write", dataRoot: root, extraSkillIds: ["sample:extra"] });
    expect(scope.persona).toContain("Check concrete evidence.");
    expect(scope.primary).toMatchObject({ id: "sample:proof" });
    expect(scope.primary!.text).toContain("Verify the claim.");
    expect(scope.skills.map(skill => skill.name)).toEqual(["sample:proof", "sample:guide", "sample:extra"]);
    expect(scope.sources).toEqual([
      { id: "sample:proof", source: "bundled" }, { id: "sample:guide", source: "bundled" }, { id: "sample:extra", source: "explicit" },
    ]);
    expect(scope.missingMcp).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("an over-budget primary method falls back to list mode and the fallback is recorded", async () => {
  const root = await fixture();
  try {
    const store = new ExpertStore(root);
    const created = await store.create({
      name: "Evidence reviewer", description: "Review changes", instructions: "Check concrete evidence.",
      skillIds: ["sample:proof", "sample:guide"],
      mounts: { skills: ["sample:proof", "sample:guide"], primarySkill: "sample:proof", mcp: [] },
    });
    const scope = await resolveExpertScope({ expert: snapshotExpert(created), host: "coordinator", access: "write", dataRoot: root, primaryBudgetTokens: 1 });
    expect(scope.primary).toBeUndefined();
    expect(scope.budgetFallback?.id).toBe("sample:proof");
    expect(scope.budgetFallback?.reason).toContain("超出注入预算");
    // List mode keeps the method readable on demand instead of dropping it.
    expect(scope.skills.map(skill => skill.name)).toEqual(["sample:proof", "sample:guide"]);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("declared MCP services missing from the session are reported, never skipped", async () => {
  const root = await fixture();
  try {
    const store = new ExpertStore(root);
    const created = await store.create({
      name: "Evidence reviewer", description: "Review changes", instructions: "Check concrete evidence.",
      skillIds: ["sample:proof"],
      mounts: { skills: ["sample:proof"], primarySkill: "sample:proof", mcp: ["sample_service"] },
    });
    const expert = snapshotExpert(created);
    expect((await resolveExpertScope({ expert, host: "coordinator", access: "write", dataRoot: root, mcpServers: [] })).missingMcp).toEqual(["sample_service"]);
    expect((await resolveExpertScope({ expert, host: "coordinator", access: "write", dataRoot: root, mcpServers: ["sample_service"] })).missingMcp).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a read-only host cannot mount a Skill that requires editing tools", async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, "plugin-packs", "sample", "skills", "proof", "SKILL.md"), "---\nname: proof\ndescription: Verify the claim.\nrequires-tools: [edit, write]\n---\n\nVerify the claim.\n");
    const store = new ExpertStore(root);
    const created = await store.create({ name: "Evidence reviewer", description: "Review changes", instructions: "Check concrete evidence.", skillIds: ["sample:proof"] });
    const expert = snapshotExpert(created);
    await expect(resolveExpertScope({ expert, host: "worker", access: "read-only", dataRoot: root })).rejects.toThrow("需要 edit");
    expect((await resolveExpertScope({ expert, host: "worker", access: "write", dataRoot: root })).skills.map(skill => skill.name)).toEqual(["sample:proof"]);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("built-in experts map their registered primarySkill to the mounted primary method", async () => {
  const root = await fixture();
  try {
    const withMethod = (await new ExpertStore(root).templates()).filter(item => item.package?.mounts?.primarySkill);
    expect(withMethod.length).toBeGreaterThan(20);
    for (const item of withMethod) {
      expect(item.package!.mounts!.primarySkill).toBe(item.skillIds![0]);
      expect(item.package!.mounts!.skills).toEqual(item.skillIds!);
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
