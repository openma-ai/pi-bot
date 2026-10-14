import type { Api, Model } from "@earendil-works/pi-ai";
export interface ImageBudget {
  tokensPerImage: number;
  maxImages: number;
  maxImageBytes: number;
}
/** Official vision bounds: api-docs.deepseek.com/news/news260821/ and guides/vision/. */
export function imageBudgetForModel(
  model: Model<Api>,
): ImageBudget | undefined {
  let endpoint: URL;
  try {
    endpoint = new URL(model.baseUrl);
  } catch {
    return undefined;
  }
  if (
    model.provider !== "deepseek" ||
    endpoint.protocol !== "https:" ||
    endpoint.hostname !== "api.deepseek.com" ||
    endpoint.port ||
    !["", "/", "/v1", "/v1/"].includes(endpoint.pathname) ||
    ![
      "deepseek-flash",
      "deepseek-v4-flash",
      "deepseek-v4-flash-vision-exp",
    ].includes(model.id)
  )
    return undefined;
  return {
    tokensPerImage: 384,
    maxImages: 600,
    maxImageBytes: 32 * 1024 * 1024,
  };
}
export function withVerifiedImageCapability<T extends Model<Api>>(model: T): T {
  return imageBudgetForModel(model) && !model.input.includes("image")
    ? { ...model, input: [...model.input, "image"] }
    : model;
}
