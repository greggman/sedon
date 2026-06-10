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
   every entity's world transform. Most modifiers (geom/transform,
   geom/bevel, geom/extrude, geom/inset, geom/mirror) operate on
   Geometry; placement and composition happen at the Scene layer.

2. Subgraphs as reusable assets. A subgraph is a named, parametric
   sub-graph with its own input + output sockets. It shows up in
   the Asset panel and is instanced by reference — drilling into a
   "chair" subgraph edits the SAME data every instance uses, so
   one edit re-tints / re-shapes every chair in the scene at once.
   The node kind for an instance is "subgraph/<id>".

3. Real-time eval. Mutations (add node, connect, set input value)
   trigger re-evaluation through an eval cache keyed on per-node
   fingerprints — unchanged nodes return their cached result, so
   editing a single value re-evaluates only its dependents.

KEY VALUE TYPES (so tool calls produce edges with matching types):
  Float, Int, Bool, Vec2, Vec3, Vec4, Color, Texture2D, Geometry,
  Material, Scene, PointCloud, Vec3Cloud, FloatCloud, Path,
  Heightfield, Lighting.

Type compatibility is mostly strict, but a few useful broadcasts
exist — you can rely on these to skip "constant" nodes:
  - Int → Float
  - Float → Vec2 / Vec3 / Vec4    (broadcasts the same value to every component)
  - Color ↔ Vec4
  - Color → Texture2D             (a flat colour wired to a Texture2D socket auto-promotes to a 1×1 texture)
Any other connection fails with code \`type_mismatch\`.

=================================================================
HOW TO BUILD A SCENE — read this before any mutation.
=================================================================

THE ROOT. \`core/output\` is the eval root. Its FIRST input is named
\`scene\` and expects a Scene. Everything else (light_direction,
light_color, light_intensity, terrain_tint, …) has sensible defaults
— you don't have to wire them. NOTHING RENDERS unless something is
connected to \`core/output.scene\`. Most agent-induced "I built a
graph and nothing shows up" bugs come from skipping this wire.

MINIMUM RENDER RECIPE. To make a single cube appear on screen:
  1.  addNode geom/cube                 → id = cubeId
  2.  addNode material/pbr              → id = matId
  3.  addNode scene/entity              → id = entId
  4.  connect cubeId.geometry  → entId.geometry
  5.  connect matId.material   → entId.material
  6.  addNode core/output               → id = outId  (auto-promoted to root)
  7.  connect entId.scene      → outId.scene
That's the whole pipeline. To recolour the cube, no extra node:
\`setInputValue(matId, 'color', [1, 0.2, 0.2, 1])\`.

MORE THAN ONE OBJECT. \`core/output.scene\` takes a SINGLE Scene.
To render multiple objects, combine them with \`scene/merge\` first:
  cube/entity → scene/merge.scenes
  sphere/entity → scene/merge.scenes
  scene/merge.scene  →  core/output.scene
\`scene/merge.scenes\` is a MULTI-FAN-IN socket: you can connect any
number of Scene outputs into the same socket name and the merge
concatenates them in edge-creation order. \`listNodeKinds\` flags
multi sockets with \`multi: true\` on the InputDef; treat any such
socket the same way.

DEFAULTS EXIST. Don't wire a constant node just to feed a literal
value. Every input has a default; if you want a different scalar /
vector / colour, call \`setInputValue\` with the raw value. For
Texture2D inputs that declare a colour default, passing a Color is
enough — Sedon promotes it to a 1×1 texture at eval time.

LAZY EVAL FROM THE ROOT. Nodes that aren't transitively reachable
from \`core/output\` are not evaluated, full stop. If you added
nodes and "nothing changed," the first thing to check is whether
the new chain reaches \`core/output.scene\`.

=================================================================
SUBGRAPHS
=================================================================

A subgraph is a reusable asset (chair, tree, building, etc.). Two
distinct steps:

DEFINE A SUBGRAPH. \`createSubgraph(id, label)\` creates an empty
subgraph AND switches the editing context to it. After that call,
subsequent \`addNode\` / \`connect\` calls land INSIDE the
subgraph, not in the main graph. Use \`getActiveEditing\` to
confirm where you are. To add input / output sockets to the
subgraph's surface, use \`addSubgraphSocket\`. Sockets surface as
named handles on boundary nodes inside the subgraph (kinds
\`subgraph-input/<id>\` and \`subgraph-output/<id>\`) and on every
wrapper instance in parent graphs.

INSTANCE A SUBGRAPH. Just defining a subgraph doesn't put it in
your scene. Switch back to "main" with \`setActiveEditing('main')\`
and \`addNode\` the wrapper kind \`subgraph/<your-id>\`. That
wrapper has the input/output sockets you declared via
addSubgraphSocket; wire it like any other node.

STANDALONE PREVIEW. A subgraph CAN contain a \`core/output\` node
of its own. When present, that's what the standalone preview pane
shows when the user drills into the subgraph. Otherwise the
preview renders the subgraph's boundary output directly.

=================================================================
VALIDATION ERRORS
=================================================================

Mutating tools (addNode, connect, setInputValue) return
\`{ ok: false, error: { code, message, detail } }\` on bad input.
Codes you'll see and what to do:

  node_not_found       → the nodeId doesn't exist in the active
                         graph. Recheck via \`listGraphNodes\`. If
                         you're inside the wrong graph, switch with
                         \`setActiveEditing\`.
  unknown_kind         → the node kind id is wrong. Look it up via
                         \`listNodeKinds\`; don't guess.
  socket_not_found     → the socket name is wrong on that node.
                         \`detail.side\` tells you whether it's an
                         input or output. Re-read the node's
                         schema in listNodeKinds.
  type_mismatch        → either the output type can't connect to
                         the input type (check the broadcast list
                         above), or a setInputValue got a value
                         of the wrong shape (e.g. a string into a
                         Float, a length-2 array into a Vec3).
  self_loop            → can't connect a node's output back to its
                         own input.
  duplicate_node_id /
  duplicate_edge_id    → the id you supplied is taken. Omit \`id\`
                         to get a fresh uuid.

=================================================================
COMMAND PATTERN
=================================================================

Every authoring mutation is a Command that the store dispatches
through a single applyForward function and reversibly inverts via
applyBackward. That's why every MCP mutation tool here is undoable
for free — there is no separate undo machinery for tool-driven
edits.

=================================================================
TOOL USAGE TIPS
=================================================================

- Call \`listNodeKinds\` AT LEAST ONCE before mutating. It gives
  you every available kind and its input / output socket schema —
  the registry is the source of truth. Cache it locally; it only
  changes when you create a subgraph (which adds a new wrapper
  kind \`subgraph/<id>\`).
- Wire sockets by EXACT NAME. Don't guess from the type. The
  socket on \`core/output\` is named \`scene\`, not \`output\` or
  \`in\`.
- When unsure if something rendered, call \`getNodeInputValue\`
  / \`listGraphNodes\` to inspect, or just trust the error codes
  above.
`.trim();
