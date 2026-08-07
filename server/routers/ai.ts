/**
 * AI chat router — backs client/src/components/AIChatBox.tsx
 *
 * AIChatBox calls `trpc.ai.chat.useMutation()` with `{ messages }` where each
 * message is `{ role: "system" | "user" | "assistant", content: string }`,
 * and uses the mutation result directly as the assistant reply string.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import { invokeLLM, type TextContent } from "../_core/llm";

const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().min(1).max(32_000),
});

export const aiRouter = router({
  chat: protectedProcedure
    .input(
      z.object({
        messages: z.array(chatMessageSchema).min(1).max(100),
      })
    )
    .mutation(async ({ input }) => {
      const result = await invokeLLM({ messages: input.messages });
      const content = result.choices?.[0]?.message?.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter((part): part is TextContent => part.type === "text")
                .map((part) => part.text)
                .join("")
            : "";
      if (!text) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "LLM returned an empty response",
        });
      }
      return text;
    }),
});
