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

### Local Development (with AI Playground)

```bash
# In the AI Playground directory
npm run plugins:fetch https://github.com/c2s-bouygues/c2s.aiplayground.opensource.git main
npm run dev
```

## Plugin Playground

This repository includes a built-in test interface to quickly develop and test plugins without needing the full AI Playground platform.

### Quick Start

```bash
# Clone this repository
git clone https://github.com/c2s-bouygues/c2s.aiplayground.opensource.git
cd c2s.aiplayground.opensource

# Install dependencies
npm install

# Copy and configure environment variables
cp .env.example .env
# Edit .env with your API keys

# Start the playground
npm run dev
```

Open http://localhost:5173 in your browser to access the Plugin Playground.

### Features

- **Plugin browser**: View all available plugins and their metadata
- **Configuration editor**: Set environment variables and plugin config
- **Tool tester**: Execute tools with custom parameters
- **Result viewer**: See tool execution results in real-time

### Adding a New Plugin

1. Create a new directory in `plugins/`:
   ```bash
   mkdir plugins/my-plugin
   ```

2. Create the required files:
   - `manifest.json` - Plugin metadata
   - `index.ts` - Plugin export
   - `tools/` - Tool implementations

3. Import your plugin in `src/lib/server/plugin-loader.ts`:
   ```typescript
   import myPlugin from '../../../plugins/my-plugin';

   const loadedPlugins: PluginExport[] = [
     weatherPlugin,
     pixabayPlugin,
     fetchPlugin,
     bingPlugin,
     myPlugin  // Add your plugin here
   ];
   ```

4. Restart the dev server - your plugin will appear in the playground!

## Available Plugins

| Plugin | Category | Description | Required env vars | Status |
|--------|----------|-------------|-------------------|--------|
| `weather` | utility | Demo plugin returning mock weather data | — | Ready |
| `pixabay` | search | Search for royalty-free images via Pixabay | `PIXABAY_API_KEY` | Ready |
| `fetch` | utility | Fetch and parse web page content as Markdown | — | Ready |
| `bing` | search | Web search via an Azure AI Foundry agent with Bing grounding | `AZURE_FOUNDRY_BING_ENDPOINT` `AZURE_FOUNDRY_BING_API_KEY` | Ready |

### Bing Web Search Plugin

Calls an Azure AI Foundry agent pre-configured with **Bing grounding** to answer search queries with real-time web results. Each call sends a single request to the Foundry Responses API exposed by the agent application.

Important: when you use an agent application endpoint (`.../applications/{agent-name}/protocols/openai/responses`), per-request `instructions` are rejected by Azure Foundry. Configure the system prompt and grounding behavior directly in the Foundry agent instead.

#### Setup

1. In [Azure AI Foundry](https://ai.azure.com), create an agent and enable the **Bing grounding** tool.
2. From the agent's API details, copy the **Responses API endpoint URL** (format: `https://{resource}.services.ai.azure.com/api/projects/{project}/applications/{agent-name}/protocols/openai/responses`).
3. Generate an **API key** for the Foundry project.
4. Set the environment variables:

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `AZURE_FOUNDRY_BING_ENDPOINT` | ✅ | Full Responses API URL for the agent application | `https://aif-xxx.services.ai.azure.com/api/projects/proj-xxx/applications/Agent-Bing-Search/protocols/openai/responses` |
| `AZURE_FOUNDRY_BING_API_KEY` | ✅ | API key for the Foundry project | `abc123...` |
| `AZURE_FOUNDRY_BING_MODEL` | — | Model deployment name (only needed if the endpoint requires it) | `gpt-4o` |

#### Tool: `search_bing`

| Input | Type | Required | Description |
|-------|------|----------|-------------|
| `q` | string | ✅ | Natural language search query |
| `count` | number | — | Hint for number of results (1–20) |

Returns `{ message, content }` where `content` is the agent's synthesized answer.

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
