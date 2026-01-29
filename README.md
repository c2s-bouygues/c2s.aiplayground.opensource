# AI Playground - MCP Plugins

This repository contains open-source MCP (Model Context Protocol) plugins for the AI Playground chatbot platform.

## Installation

These plugins are automatically loaded during the Docker build process when deploying AI Playground.

### Coolify Configuration

Add these build arguments in your Coolify deployment settings:

```
PLUGIN_REPO_URL=https://github.com/c2s-bouygues/c2s.aiplayground.opensource.git
PLUGIN_BRANCH=main
ENABLED_PLUGINS=weather  # comma-separated, or empty for all
```

### Local Development

```bash
# In the AI Playground directory
npm run plugins:fetch https://github.com/c2s-bouygues/c2s.aiplayground.opensource.git main
npm run dev
```

## Available Plugins

| Plugin | Description | Status |
|--------|-------------|--------|
| `weather` | Demo plugin returning mock weather data | Ready |

## Creating a Plugin

Each plugin must have:

1. A `manifest.json` with metadata and tool declarations
2. An `index.ts` exporting the plugin definition
3. Tool implementations in `tools/` directory

### Plugin Structure

```
plugins/
└── my-plugin/
    ├── manifest.json      # Plugin metadata
    ├── index.ts           # Main export
    └── tools/
        └── my-tool.ts     # Tool implementation
```

### Manifest Example

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "Description of what the plugin does",
  "author": "Your Name",
  "license": "MIT",
  "icon": "hugeicons:puzzle",
  "category": "utility",
  "requiredEnvVars": ["MY_API_KEY"],
  "optionalEnvVars": [],
  "configSchema": {
    "type": "object",
    "title": "Configuration",
    "properties": {
      "defaultValue": {
        "type": "string",
        "title": "Default Value",
        "default": "example"
      }
    }
  },
  "tools": [
    {
      "id": "my_tool",
      "name": "My Tool",
      "description": "What the tool does",
      "systemPromptInstructions": {
        "fr": "- my_plugin_my_tool: Description en francais",
        "en": "- my_plugin_my_tool: English description"
      }
    }
  ]
}
```

### Tool Implementation Example

```typescript
import { tool, jsonSchema } from 'ai';
import type { PluginContext, AnyTool } from '../../../../src/lib/server/mcp/plugins/types';

interface MyToolParams {
  input: string;
}

export function createMyTool(context: PluginContext): AnyTool {
  return tool({
    description: 'Tool description for the LLM',
    inputSchema: jsonSchema<MyToolParams>({
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Input parameter' }
      },
      required: ['input']
    }),
    execute: async (params) => {
      context.logger.info('Executing tool', { input: params.input });

      // Your logic here
      const result = `Processed: ${params.input}`;

      return {
        message: result,
        success: true
      };
    }
  });
}
```

## License

MIT License - See [LICENSE](LICENSE) for details.
