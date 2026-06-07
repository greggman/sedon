// WebMCP browser adapter. The proposal landscape is in flux —
// Chromium has experimental `window.modelContext` work, the W3C
// proposal has shifted shape a couple of times — so this module
// feature-detects multiple plausible shapes and registers tools
// against whichever is present. When no API is exposed, the tools
// stay reachable via `window.sedonMcp.tools` so a userland script,
// browser extension, or future MCP bridge can drive them directly.
//
// Single source of truth for the tool list: `./tools.ts`. This
// module ONLY adapts that list to whatever the host browser /
// extension expects. Keeping the adaptation thin means a spec
// update is a one-file change.

import type { SedonTool } from './tools.js';

// Debug-time access from `window.sedonMcp` regardless of whether
// any browser-side MCP plumbing is present. Always set — lets
// repros, headless tests, and curious users poke the tool list
// without going through an agent.
declare global {
  interface Window {
    sedonMcp?: {
      tools: SedonTool[];
      /** Call a tool by name with an args object; returns whatever the handler returns. */
      call: (name: string, args?: Record<string, unknown>) => unknown;
    };
  }
}

/**
 * Register `tools` with the browser's WebMCP host (if present) AND
 * publish them on `window.sedonMcp` for direct access. Idempotent:
 * a second call replaces the previously-registered list.
 *
 * Returns a small object with a `registered` flag describing which
 * surface accepted the tools — handy for logging at boot.
 */
export function registerSedonTools(tools: SedonTool[]): {
  webmcp: boolean;
  windowExpose: boolean;
} {
  if (typeof window === 'undefined') {
    return { webmcp: false, windowExpose: false };
  }

  // Direct-access surface: always available, lives on window so
  // tests and userland scripts can drive tools without an agent.
  window.sedonMcp = {
    tools,
    call: (name, args = {}) => {
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new Error(`sedonMcp.call: no tool named "${name}"`);
      return tool.handler(args);
    },
  };

  // Best-effort WebMCP registration. Three plausible shapes have
  // surfaced in different drafts; we try each in turn. If none
  // matches, the tools are still reachable via the window surface
  // above.
  let webmcpRegistered = false;
  try {
    // Shape A: navigator.modelContext.registerTool(toolDescriptor).
    // Closest to the current W3C-incubation proposal.
    const nav = navigator as unknown as {
      modelContext?: {
        registerTool?: (descriptor: {
          name: string;
          description: string;
          inputSchema: object;
          execute: (args: Record<string, unknown>) => unknown;
        }) => unknown;
      };
    };
    if (typeof nav.modelContext?.registerTool === 'function') {
      for (const tool of tools) {
        nav.modelContext.registerTool({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          execute: tool.handler,
        });
      }
      webmcpRegistered = true;
    }

    // Shape B: window.modelContext.tools.set(name, descriptor).
    // The Chromium experimental shape, last we checked.
    const winMc = (window as unknown as {
      modelContext?: {
        tools?: {
          set?: (name: string, descriptor: {
            description: string;
            inputSchema: object;
            handler: (args: Record<string, unknown>) => unknown;
          }) => unknown;
        };
      };
    }).modelContext;
    if (!webmcpRegistered && typeof winMc?.tools?.set === 'function') {
      for (const tool of tools) {
        winMc.tools.set(tool.name, {
          description: tool.description,
          inputSchema: tool.inputSchema,
          handler: tool.handler,
        });
      }
      webmcpRegistered = true;
    }
  } catch (e) {
    // Don't let a malformed host API break the editor — log and
    // fall through to the window-exposed surface.
    // eslint-disable-next-line no-console
    console.warn('Sedon MCP: WebMCP registration failed, tools still reachable via window.sedonMcp', e);
  }

  return { webmcp: webmcpRegistered, windowExpose: true };
}
