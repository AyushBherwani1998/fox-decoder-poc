import "dotenv/config";
import { decodeCalldata, type DecodedCalldata } from "@metamask/fox-sdk/plugins/calldata-decoder";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { createPublicClient, http, erc20Abi } from "viem";
import { mainnet } from "viem/chains";
import { SYSTEM_PROMPT, LOOKUP_TOKEN_TOOL, buildUserMessage } from "./prompt";

const MODEL = process.env.LITELLM_MODEL || "gemini-3-flash-preview";

const client = new OpenAI({
  apiKey: process.env.LITELLM_API_KEY,
  baseURL: process.env.LITELLM_BASE_URL || "http://0.0.0.0:4000",
});

const publicClient = createPublicClient({
  chain: mainnet,
  transport: http("https://eth.api.pocket.network"),
});


async function lookupToken(address: string): Promise<{ name: string; symbol: string; decimals: number | null }> {
  try {
    const [name, symbol, decimals] = await Promise.all([
      publicClient.readContract({ address: address as `0x${string}`, abi: erc20Abi, functionName: "name" }),
      publicClient.readContract({ address: address as `0x${string}`, abi: erc20Abi, functionName: "symbol" }),
      publicClient.readContract({ address: address as `0x${string}`, abi: erc20Abi, functionName: "decimals" }),
    ]);
    return { name, symbol, decimals };
  } catch (error) {
    return { name: "Unknown", symbol: "Unknown", decimals: null };
  }
}

async function generateIntent(decoded: DecodedCalldata, to: string): Promise<{ intent: { summary: string | undefined } }> {
  if (decoded.intent) {
    return { intent: { summary: decoded.intent } };
  }

  if (!decoded.functionName) {
    return { intent: { summary: undefined } };
  }

  const paramList = decoded.params
    .map((p) => `  - ${p.name} (${p.type}): ${p.value}`)
    .join("\n");

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserMessage(decoded.functionName, paramList, to) },
  ];

  let response = await client.chat.completions.create({
    model: MODEL,
    messages,
    tools: [LOOKUP_TOKEN_TOOL],
  });


  // Tool call loop — handle lookup_token calls until the model produces a final response
  while (response.choices[0]?.finish_reason === "tool_calls") {
    const assistantMessage = response.choices[0].message;
    messages.push(assistantMessage as ChatCompletionMessageParam);

    const toolCalls = assistantMessage.tool_calls || [];
    for (const toolCall of toolCalls) {
      if (toolCall.type !== "function" || toolCall.function.name !== "lookup_token") continue;
      const args = JSON.parse(toolCall.function.arguments);
      const result = await lookupToken(args.address);
      messages.push({
        role: "tool" as const,
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }

    response = await client.chat.completions.create({
      model: MODEL,
      messages,
    });
  }

  const text = response.choices[0]?.message?.content || "";

  try {
    return JSON.parse(text);
  } catch {
    return { intent: { summary: text || "Could not generate intent." } };
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 3) {
    console.log("Usage: npx tsx src/index.ts <calldata> <chainId> <toAddress>");
    console.log("");
    console.log("Examples:");
    console.log("  # ERC-20 transfer");
    console.log('  npx tsx src/index.ts "0xa9059cbb000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa960450000000000000000000000000000000000000000000000000de0b6b3a7640000" 1 "0xdAC17F958D2ee523a2206206994597C13D831ec7"');
    console.log("");
    console.log("  # Uniswap V2 swapExactTokensForTokens");
    console.log('  npx tsx src/index.ts "0x38ed173900000000000000000000000000000000000000000000000000000000000f4240000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa9604500000000000000000000000000000000000000000000000000000000683b8f0c0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" 1 "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"');
    process.exit(1);
  }

  const [calldata, chainIdStr, to] = args;
  const chainId = Number(chainIdStr);

  console.log("Decoding calldata...\n");

  const decoded = await decodeCalldata(calldata, chainId, to);

  console.log("Decoded result:");
  if (decoded.functionName) {
    console.log(`  Function: ${decoded.functionName}`);
  }
  if (decoded.params.length > 0) {
    console.log("  Parameters:");
    for (const p of decoded.params) {
      console.log(`    ${p.name} (${p.type}): ${p.value}`);
    }
  }
  if (decoded.intent) {
    console.log(`  ERC-7730 Intent: ${decoded.intent}`);
  }

  console.log("\nGenerating human-readable intent...\n");

  const result = await generateIntent(decoded, to);
  console.log(JSON.stringify(result, null, 2));
}

main().catch(console.error);
