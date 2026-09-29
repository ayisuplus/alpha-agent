import { expect, test } from "bun:test";
import { modelPreference, type NativeModel } from "../desktop/ui/src/app/native-api";

test("separates OMP thinking suffixes but preserves model IDs containing a colon", () => {
  const models = [{ selector: "provider/model" }, { selector: "provider/model:high" }] as NativeModel[];
  expect(modelPreference(models, "provider/model:high")).toEqual({ selector: "provider/model:high", thinking: "" });
  expect(modelPreference(models, "provider/model:high:max")).toEqual({ selector: "provider/model:high", thinking: "max" });
  expect(modelPreference(models, "provider/model:auto")).toEqual({ selector: "provider/model", thinking: "auto" });
});
