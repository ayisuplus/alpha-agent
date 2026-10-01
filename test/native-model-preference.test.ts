import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NativeSettings } from "../desktop/ui/src/app/NativeSettings";
import { modelPreference, type NativeModel } from "../desktop/ui/src/app/native-api";

test("separates OMP thinking suffixes but preserves model IDs containing a colon", () => {
  const models = [{ selector: "provider/model" }, { selector: "provider/model:high" }] as NativeModel[];
  expect(modelPreference(models, "provider/model:high")).toEqual({ selector: "provider/model:high", thinking: "" });
  expect(modelPreference(models, "provider/model:high:max")).toEqual({ selector: "provider/model:high", thinking: "max" });
  expect(modelPreference(models, "provider/model:auto")).toEqual({ selector: "provider/model", thinking: "auto" });
});

test("native role settings display model names for thinking suffixes and literal colon ids without changing saved preferences", () => {
  for (const [selector, configured, name] of [["provider/model", "provider/model:high", "Thinking model"], ["provider/model:high", "provider/model:high", "Literal colon model"]]) {
    const model: NativeModel = { selector, provider: "provider", id: selector.slice(9), name, available: true, reasoning: true, contextWindow: 100000 };
    const config = { agentDir: "native-profile", settings: [], modelRoles: { default: configured } };
    const noop = () => undefined;
    const markup = renderToStaticMarkup(createElement(NativeSettings, {
      config, catalog: { models: [model], roles: [{ id: "default", name: "Default", candidates: [selector] }], providers: [], error: null },
      theme: "light", setTheme: noop, onConfig: noop, reload: async () => {}, onClose: noop, fontSize: 15, setFontSize: noop,
      diagnostics: false, setDiagnostics: noop, update: null, onCheckUpdate: noop, sessionId: null, onUseSkill: noop,
    }));
    expect(markup).toContain(`>${name}<`);
    expect(config.modelRoles.default).toBe(configured);
  }
});
