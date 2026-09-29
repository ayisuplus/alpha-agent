import { resolve } from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { ComfyClient } from "./comfy-client";
import { createImageTool } from "./image-tool";
import { createVoiceTool } from "./voice-tool";
import { createVideoTool } from "./video-tool";

export interface ComfyPluginOptions {
  projectRoot: string;
  dataRoot: string;
  url?: string;
  enabled?: boolean;
  generation?: { image: boolean; voice: boolean; video: boolean };
}

const statusParameters = type({});

export function createComfyStatusTool(client = new ComfyClient()): ToolDefinition<typeof statusParameters> {
  return {
    name: "alpha_comfy_status",
    label: "Check local ComfyUI",
    description: "Check whether the user's local ComfyUI is available before attempting media generation. Never start or replace the service.",
    parameters: statusParameters,
    loadMode: "essential",
    async execute() {
      const online = await client.health();
      return { content: [{ type: "text", text: JSON.stringify({ online }) }] };
    },
  };
}

export function createComfyPlugin(options: ComfyPluginOptions): { tools: ToolDefinition[]; instructions: string[] } {
  if (options.enabled === false) return { tools: [], instructions: [] };
  const image = options.generation?.image ?? true;
  const voice = options.generation?.voice ?? true;
  const video = (options.generation?.video ?? true) && image;
  const presets = resolve(import.meta.dir, "..", "..", "..", "..", "presets");
  return {
    tools: [
      createComfyStatusTool(new ComfyClient(options.url)),
      ...(image ? [createImageTool(options.projectRoot, options.dataRoot, resolve(presets, "flux2-image.api.json"), options.url)] : []),
      ...(voice ? [createVoiceTool(options.projectRoot, options.dataRoot, resolve(presets, "voxcpm2-voice.api.json"), options.url)] : []),
      ...(video ? [createVideoTool(options.projectRoot, options.dataRoot, resolve(presets, "h3-video.api.json"), options.url)] : []),
    ],
    instructions: [
      "ComfyUI is a local built-in plugin. Use alpha_comfy_status when you need to check its availability. If the local service is unavailable, report that honestly; do not start it or switch services.",
      ...(image ? ["When the product needs an original illustration or other generated image, call alpha_generate_image with a product-specific visual prompt, then reference its returned asset URL exactly in the product and check it in the browser. Do not rename, copy, or recreate the returned binary asset with the write tool. If the user says not to generate new images, do not call it."] : []),
      ...(voice ? ["When the product needs spoken narration or voice audio, call alpha_generate_voice with the exact words and a brief voice description, then reference its returned FLAC URL exactly. Do not call it when the user forbids generation. Browser loading and format checks do not prove listening quality; report listening review as pending unless it was actually performed."] : []),
      ...(video ? ["When the product needs original video, first call alpha_generate_image with aspect=landscape if no suitable 16:9 PNG exists. Pass the exact returned /alpha-assets/...png URL to alpha_generate_video with a precise motion prompt; never create a placeholder reference.png or rewrite the generated binary. Treat the result as a candidate. The verification plan must include a video step targeting the page's video element; the runtime checks decoded start, middle and end frames after publication. Do not claim subjective visual approval unless those frames were actually reviewed. Do not generate video when the user forbids new media."] : []),
      ...(!image || !voice || !video ? [`These ComfyUI media tools are turned off in Alpha's settings: ${[!image && "image", !voice && "voice", !video && "video"].filter(Boolean).join(", ")}. If the product needs such media, use existing assets or CSS/SVG made in code, and tell the user that generation is off.`] : []),
    ],
  };
}
