// LLM-facing introduction to Sedon. Surfaced via the
// `getSedonOverview` MCP tool and snippeted into the descriptions of
// tools that need the LLM oriented before it starts dispatching
// mutations. Written as if explaining the editor to a competent 3D
// person who has never seen this project before.
//
// Keep this in sync with what the editor actually does — out-of-date
// orientation text is worse than none, because the LLM will trust
// it. If a sentence here can't be backed by the current behaviour,
// rewrite or delete it.

export const SEDON_OVERVIEW = `
Sedon is a node-based procedural 3D editor that runs in the browser
on WebGPU. It is heavily inspired by Houdini's SOPs (Surface
Operators) and Blender's Geometry Nodes, but it targets REAL-TIME
3D rather than offline rendering.

The visual model is a graph of nodes wired socket-to-socket. Each
node has a kind id (e.g. "geom/sphere", "geom/transform",
"scene/entity"), a list of input sockets, and a list of output
sockets. Edges connect one node's output socket to another node's
input socket. Evaluation pulls from the root output and walks
backwards through the graph, lazily evaluating each node only as
needed.

KEY DIFFERENCES from Houdini SOPs and Blender Geometry Nodes:

1. Scene as a first-class type. Houdini and Blender's node graphs
   operate primarily on Geometry. Sedon has BOTH:
   - Geometry: mesh data (positions, normals, uvs, indices).
   - Scene: a list of entities, each carrying { geometry, material,
     transform, tint }, plus optional terrain / grass / water side
     bands.
   Scenes are what get rendered. \`scene/entity\` wraps a
   Geometry+Material into a one-entity Scene; \`scene/merge\`
   composes multiple Scenes; \`scene/transform\` left-multiplies
   every entity's world transform. Most modifiers (transform-
   geometry, bevel, extrude, inset, mirror) operate on Geometry;
   placement and composition happen at the Scene layer.

2. Subgraphs as reusable assets. A subgraph is a named, parametric
   sub-graph with its own input + output sockets. It shows up in
   the Asset panel and is instanced by reference — drilling into a
   "chair" subgraph edits the SAME data every instance uses, so
   one edit re-tints / re-shapes every chair in the scene at once.
   The node kind for an instance is "subgraph/<id>".

3. Real-time eval. Mutations (add node, connect, set input value)
   trigger re-evaluation through an eval cache keyed on per-node
   fingerprints — unchanged nodes return their cached result, so
   editing a single value re-evaluates only its dependents. This is
   what makes the canvas feel like an interactive editor instead of
   a render-when-asked DAG.

KEY VALUE TYPES (so tool calls produce edges with matching types):
  Float, Int, Bool, Vec2, Vec3, Vec4, Color, Texture2D, Geometry,
  Material, Scene, PointCloud, Vec3Cloud, FloatCloud, Path,
  Heightfield, Lighting.

Type compatibility is mostly strict; a few documented broadcasts
exist (Float → Vec2/3/4, Int → Float, Color ↔ Vec4). Connecting
incompatible sockets fails the edge.

COMMAND PATTERN. Every authoring mutation is a Command (addNode,
removeNodes, connect, removeEdges, setInputValue, replaceGraph,
replaceProject) that gets dispatched through a single applyForward
function and reversibly inverted by applyBackward. That's why every
MCP mutation tool here is undoable for free — there is no separate
undo machinery for tool-driven edits.

WHEN USING THESE TOOLS to build a subgraph or scene:
- Start by calling \`listNodeKinds\` to see available node ids and
  their input/output socket schemas. Don't guess kind ids or socket
  names; the registry is the source of truth.
- Use \`createSubgraph\` to make a new asset, then call
  \`setActiveEditing\` to focus its canvas so subsequent addNode /
  connect calls land inside that subgraph. Subgraph inputs and
  outputs are surfaced as \`subgraph-input/<id>\` and
  \`subgraph-output/<id>\` boundary nodes inside the graph.
- Wire sockets by exact name. Look at each node's inputs / outputs
  via \`listNodeKinds\` to find the names.
- Author values with \`setInputValue\`. Pass the raw value (number,
  array, string) — the editor converts.
- Always end a Scene-producing graph at a \`core/output\` node.
  Without it, nothing renders. Subgraphs that produce Geometry or
  Texture2D don't need core/output — they emit their final value at
  the subgraph-output boundary.
`.trim();
