/** Keep Pi's actual execution details in DSH's durable presentation metadata. */
import { createMcpToolDefinition } from "@deepseek-ai/dsh-mcp-client";

export function createPiToolDefinition(ctx, options) {
  const details = new WeakMap();
  const definition = createMcpToolDefinition(ctx, { ...options, call: async (args, execution) => {
    const result = await options.call(args, execution);
    if (result._meta?.["remote/pi"] !== undefined) details.set(execution, result._meta["remote/pi"]);
    return result;
  } });
  const execute = definition.execute;
  const projectContent = definition.projectContent;
  return { ...definition,
    output: { ...definition.output,
      schema: { ...definition.output.schema, properties: { ...definition.output.schema.properties, piPresentation: {} } },
      presentationMeta: (_args, value) => value.piPresentation === undefined ? undefined : { remotePi: value.piPresentation },
    },
    execute: async (args, execution) => {
      try {
        const value = await execute(args, execution);
        const presentation = details.get(execution);
        return presentation === undefined ? value : { ...value, piPresentation: presentation };
      } finally { details.delete(execution); }
    },
    projectContent(execution, result) {
      // The MCP adapter correlates image storage with the original canonical
      // value. Its equality check must see that value, without our UI metadata.
      const { piPresentation: _presentation, ...value } = result.value ?? {};
      return projectContent.call(definition, execution, { ...result, value });
    },
  };
}
