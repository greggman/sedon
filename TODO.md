# TODOs

- [ ] need preferences (saved in local storage?)
  - [ ] default sky settings (used in all node previews)
  - [ ] default material color (should not be white)
- [ ] what other texture nodes exist in blender/houdini/substance-designer?
- [ ] move options to hash
- [ ] need LODs so trees work?
- [ ] add more tests - we called "scripts/verify-outline-clamp.mjs"
  a regression test but it's not useful if it's not run. We need to run
  all the test.
- [ ] flip-normals node
- [ ] need a way to include scenes so they can be updated in separate files?
- [ ] Test rename with multiple asset views open. 
  Also test Add New Subgraph which indirectly does a rename
- [ ] subdivision, loop-cut, smooth, edge-split
  same blocker as bevel — needs the connectivity layer.
- [*] import png, jpg, webp (use URL where # is local)
  - [ ] drag and drop
    issue, what does it mean? Drag and drop is for local files os this would
    have to add data that needs to be serialized on save.
    - [ ] drag and drop image in canvas
    - [ ] drag and drop image on node
- [ ] import gltf
  Need to decide how to import. Seems like rather than the entire scene
  you should be able to reference individual assets (models, textures, materials).
  That suggests the output from a subscene should maybe be more complex?
  Or, it should import the gLTF as the collection of its parts as well as a scene
  that uses all of them. So they'd show up in the asset tree as like folders
- [ ] should zoom level in canvas be reset on load? is graph position saved?
  currently if I start with the scene=leaf it's zoomed in. When I load the forest it's also zoomed in.
- [ ] what is core/palette?
- [ ] prevent 2nd subscene/input, subscene/output?
- [ ] add previews for point nodes (they exist in docs)
- [ ] document subscene-input/subscene-output
- [ ] what is carve-heightfield, why not just a texture with subtract?
- [ ] no points on split (even defaults) 
- [ ] split doesn't work (delete point, add point, new point is not used)
- [ ] write dev docs for LLMs (and humans)
- [ ] nodes need to not crash (wave_scale = 0) for example
- [ ] cleanup graph needs to frame the graph (though maybe not change zoom? Just go to
 middle at same zoom level?)
- [ ] make dragging asset to tab bar tab, make that asset that tab, off tab, edit that asset in new tab
- [ ] in preview spline editor
- [ ] in preview TRS editor
- [ ] grass blades should be made with leaf nodes
- [ ] add SSAO
- [ ] the direction setting should not be an open vector?
  * numbers should go 0->1->0->-1->0 right?
  * an arc transparent ball you can drag with a cone arrow inside?
- [ ] change WASD to be time based, not event based
  issue is if keys come in at 10 fps then you get 10fps movement.
  Instead. use W down to start forward movement every frame
  and W up to stop forward movement. Then you get 60fps movement.
  OTOH, if it's running slow (5fps) and you press W you'd get more movement
  per press making it harder to navigate.
- [ ] add previews for other nodes (not sure what)
  - [ ] branch/recursive
  - [ ] branch/tropism
  - [ ] branch/sample-points
  - [ ] branch/whorled-pine
- [ ] The readback in heightfield-to-mesh is unacceptable. There should be no
   reason to read back the data from the GPU. Keep it on the GPU. Do the heightMapToMesh on the GPU. Besides, we need a
   terrain renderer that tessellates the terrain
   based on distance from the camera. 
- [ ] node view (like assets)
  - [ ] nodes in folders
  - [ ] list, icon
  - [ ] drag into graph
- [ ] double click frames?
- [ ] future nodes
- [ ] add UI tests
- [ ] isTexture2D and related seems brittle
- [ ] left/skeleton needs to start from bottom center?
- [ ] scene-merge or somewhere should probably have TRS hierarchy and let you
  select nodes and drag to move in preview
- [ ] move the WebGPU parts to a worker
- [ ] need a better UI than 3 numbers for setting a direction 
- [ ] change sky to use a lookup table for speed - need to recompute
  when the sun changes.
- [ ] WGSL snippet node - meta data for types (quat vs vec4f vs color) but parse 
  for defaults
- [ ] is core/grid a valid node. maybe should be list of colors with +/- to add to
  list?
- [ ] editable texture? a node with a pixel editor?
  This is mostly for drawing terrain? Though I can
  guess you'd want to edit terrain in the preview
  with pull up, push down.
  - [ ] simple brush with alpha - like 2d blend demo
  - [ ] needs undo
- [ ] texture size should be drop down (64x64, 128x128, 256x256, 512x512, etc,
  with "custom" as option)
- [ ] need preview always - even if bad inputs (example heightfield)
- [ ] let you pull off an input (?)
  prefs because easy to break when trying to move node
- [*] add help icon at top right of each node (or bottom left as there is space)
  should be link to docs. Generate docs for each node. Docs should have live
  sample. Sample could be specified in URL as in `url?json={..}` or `url?deflate=base64` or `url?src=url` 
- [ ] allow drag and drop of scene file
- [ ] need a way to make a point cloud with more constraints
  - [ ] example: want random x,y,z but want x == z

    solutions?:

    - [ ] use 2 float clouds (xz, y) and combine into xyz point-cloud
    - [ ] custom WGSL point cloud node
    - [ ] after the fact modifier - make xyz cloud -> filter node(s) 
    - [ ] other

    Not sure if we should have one of these are all of them

- [ ] Probably need an "Inspector"

  It would show all the inputs in a node, some with better
  UIs?

- [ ] search for nodes
- [ ] material previews should use track camera, not orbit
- [ ] preview sphere should be larger 
- [ ] touch support? (iPad) - maybe iphone
- [ ] support HDR output
- [ ] camera
  - [ ] orbit vs track control (option)
  - [*] frame
  - [ ] ortho


## --- done ---

- [*] demos scene should not show up in command palette
- [*] path/curve-2d, should have a preview_texture like points/list does?
- [*] points/list shift-drag should also select (currently drag selects)
- [*] path/curve-2d, what is ⇧+click=toggle
- [*] points/list->edit->click gets error
- [*] points/list 'f' should frame (currently falls through to view behind)
- [*] points/list 'f' should frame selected (current frames all)
- [*] points/list control click - should not bring up context menu behind editor
- [*] path/curve-2d sometimes stops updating - repo:
  1. click to add point (a)
  2. click to add point (b)
  3. ctrl-click (a) to delete (a)
  4. ctrl-click (b) to delete (b)
  5. click to add point (c)
  6. click to add point (d)
  Result: (d) does not appear. click to add more points. They don't appear.
  Drag a point. They all suddenly appear.
- [*] persp camera changes zFar?
- [*] ortho drag should stick to stuff
- [*] zoom (dolly) doesn't work in ortho mod
- [*] camera doesn't snap out of ortho mode like blender
- [*] new nodes should be placed on top - in basic, add cone, then add cylinder.
  cylinder is placed under cone.
- [*] dragging and dropping cushion from asset to canvas in the furniture scene
  shows no node preview. Should it? It has defaults right? Did I forgot why this doesn't work or is it a bug?
- [*] add nodes for city
  What nodes do we need to add to make the city? We want various kinds of buildings, windows, doors, antennas, street lights, cars, roads, intersections, storefronts, etc...
- [*] We need random buildings in the city again. At the moment they are all the
  same building. I think Blender/Houdini must have some node that given inputs like maybe a lot, Or current lot + adjacent lots, selects which building subgraph to execute?
- [*] Add blender style camera widgets
- [*] do we need leaf-mesh? It seems very specific. It kind of looks like
  a portion of a sphere which we could just add. It does have a few unique-ish
  features. Just wondering if a more parameterized sphere and or some modifiers
  might be more useful? A sphere that has longitude_start, longitude_end, latitude_start, latitude_end seems like it would make the leaf. A geometry transform and squish it. I'm not against keeping the leaf if it's the right
  thing to do. It's just very specific. (decided yes, but added start/end params
  for sphere/cone/cylinder)
- [*] do we an math/aabb-points, math/aabb-scene, math/aabb-geom?
  They would take in points/geom/scene and output vec3 min, vec3 max, vec3 size.
  Then we'd probably want floats-from-vec3 that takes in a vec3 and outputs
  x,y,z each as a float?
- [*] select a connection and pick "add node" should connect the node
- [*] is there a list/array entry type (added `multi: true`)
- [*] design should not be "extra inputs". It should be "array of input name,type" (added `multi: true`)
- [*] how many nodes should have an array of inputs? (added `multi: true`)
- [*] WebMCP should probably mention minimum knowledge like you need to connect scenes to core/output OR to a subscene-output. I'm not sure what else to add it's just that I tried WebMCP today and the service made a graph but failed to connect the nodes to the output. That's one example where maybe some tips in the WebMCP data would help.
- [*] do we need transform-points?
- [*] we need to rename nodes. core/grid is a texture. vs core/grid-distribute
  which is a point generator. These are hard to find. It seems like we should name them starting with what they generate? scene-transform, points-transform, texture-grid, points-grid, etc... I don't know if that's the best naming scheme.
  I get that it's a big chore to rename all of these and I get that existing
  data will break but it feels like it's better to fix now if it will make the
  app easier to use.
- [*] make WebMCP api resilient to bad input
- [*] undo needs to work on the graph node placement
- [*] rooftop water tank needs TLC
- [*] preview 'F' with nothing selected should frame the entire scene
- [*] canvas 'F' with nothing select should frame the entire graph
- [*] label all GPU resources (buffers, textures, samplers, pipelines, bindgroups, bingrouplayouts, encoders, renderPassEncoders, computePassEncoders, samplers)
- [*] at build time, can you run the auto-layout code on the demos scenes graphs and subgraphs before saving?git 
- [*] scrubbing numbers should not add to undo - happens only on scene-input in fire escape assembled.
- [*] some operations are 2 undos, they should be one. Delete a node with  connections for example is one operation to the user but it takes two undos. Can we fix that? I'm not sure what the right way to fix it is but my guess would be to add a "play-until-end-marker" undo command and "end-play-marker" so where as before the undo-stack was ["remove-connections", "delete-nodes"], the new undo-stack would be ["end-play-marker", "remove-connections","delete-nodes", "play-until-end-marker"]. On picking undo, the system pops "play-until-end-marker", which puts it in a state to continue playing undo commands from the stack until it hits "end-play-marker". "play-until-end-marker" would need to increment some count and "end-play-marker"
would decrement some count and the system would only stop when the count is 0.
That way, if multi-undo sequences can be nested later when they need to be. Another
way would be a batch command that can nest other commands.
- [*] preview selection rendering broke - it doesn't render after picking
  or unpicking
- [*] scene-merge needs to work even if it's missing an input
- [*] I feel like the city layout is not what blender/houdini would do.
  They seem to define areas and have the areas filled with buildings.
- [*] add turn in place camera controls (maybe modifier key?)
- [*] city camera has issue - jumps forward
- [*] points needs to be able to zoom out further
- [*] points probably needs a points only mode - no lines
- [*] actions should carry descriptions - vs menus having different descriptions?
- [*] remove `layout: 'auto'`
- [*] copy/copy/paste nodes
- [*] need to be able to set default on subgraph-input
- [*] name scene .sedon
- [*] need "new scene"
  - [*] verify before deleting work
  - [ ] offer various kinds of starting scenes
- [*] asset context menu does not disappear if clicking on canvas
- [*] new subgraph needs to add a subgraph wrapper if in canvas
- [*] When I pick rename on a node in the canvas it should have the entire name text pre-selected
- [*] need a "convert to subgraph" option
  This is a shortcut. Instead copy and pasting nodes into a subgraph
  and then wiring some existing graph to use it, you just select a portion
  of an existing graph and say "convert to subgraph" and it builds a subgraph
  with those nodes, and whatever inputs and outputs are needed to replace
  them in the existing graph and wires it up.
- [*] need a New Scene option
- [*] fix issue that menu commands are not based on actions
- [*] make sure WebMCP can issue actions
- [*] fix issue that "new subgraph" is missing from command palette
- [ ] extrude options
  - [ ] by face normal (not until really needed)
  - [*] scale
- [ ] transform - should work on selection (probably no. Needs a real use-case)
  needs half-edge connectivity (face-adjacency, vertex valence). Sedon
  meshes are indexed triangle lists — to bevel edges we'd first need
  a connectivity builder (positions + indices → edge list with
  left/right faces). That's a separable, foundational change. Once
  built, both edge-bevel and inset-faces fall out naturally.
- [ ] add API for WebMCP
- [ ] curve-2d: per-point handle-type UI
  data model already supports `[x, y, handleType]` (0 = smooth, 1 =
  corner). The 2D editor only authors x / y today; until the toggle
  UI lands, all points are smooth unless someone hand-edits the
  JSON inputValue. Add per-point handle-type cycling (right-click /
  toggle button) in the point-list editor — should live alongside
  the existing point-add / point-drag / point-delete affordances.
- [ ] `core/compute-normals { cusp_angle }`
  Houdini-style. Recompute mesh normals with a cusp-angle threshold:
  edges sharper than the angle get split normals (hard edge); shallower
  edges share normals (smooth). Drives lathe / extrude / curve-2d
  output to look right for furniture where SOME edges are smooth
  bulges and others are sharp creases.
- [ ] selection-driven-gizmos
- [-] remove cube for box? (no)
- [*] push/pop view so you can enter a subgraph and pop back out
- [*] set bloom_intensity to 0 on node previews.
- [*] clicking outside a menu does not dismiss the menu
- [*] click-drag on menu does not work like a native menu
- [*] scene stored in fragment, not query
- [*] bevel
- [*] why are demo scenes not just external json files that are fetched?
  Maybe we should keep the code, but, instead of compiling it into the app
  we should just run it at compile time to export .json. That way we keep
  all the type checking and build checks but we get code removed from the app.
- [*] rename core/transform to core/transform-geometry?
- [*] no animation in node previews
- [*] extrude-along-path (`core/extrude-on-path`)
- [*] lathe (`core/lathe`)
- [*] mirror (`core/mirror`)
- [*] `core/curve-2d` (Bezier authoring, outputs Path)
- [*] TRS node, tabbing does not go to next input
- [*] long names should not stretch node
- [*] putting node in for-each-point should copy defaults.
- [*] for-each-point should show "drop subgraph here"
- [*] missing previews
- [*] shadowmaps need alpha threshold
- [*] in docs, add more TOC categories (by input, by output)
- [*] tabbing in TRS node should stay in node? (current jumps to other stuff)
- [*] add record=1 or menus, and save-recording.
- [*] fix core/ramp type too long in docs (Css change)
- [*] replace space-colonization's distrubute-on-faces with distribute-in-volume
- [*] input tool tips should have description?
- [*] favicon.ico
- [*] save selected
- [*] save subgraph
- [*] import
- [*] cut/copy/paste nodes
- [*] divider between folders and content needs to be slidable
use asset view
- [*] nodes should be nameable
- [*] leaf/skeleton needs better preview
- [*] Add node needs filter at top (or removed)
- [*] what is the point of heightfield - why is it not just a texture (f16)?
- [*] geometry nodes should have a preview?
- [*] mesh and scene preview should fill the preview element
- [*] why does erosion turn return a heightfield
- [x] in the docs, when an input is a color, insert a small square div in the value cell, before the numerical value
- [*] terrain-renderer has a bad camera - needs to move up (it's under terrain)
- [*] grass has a bad camera - needs to move up (it's under terrain)
- [*] water plane bad camera - needs to be much closer - probably does not need terrain? (node, save graph, it's a good example of not good auto-layout)
- [*] pre-zoom frame, currently when you load the page you see the canvas zoom
- [*] docs preview is not interactive (can't "camera")
- [*] MeshPreview (see through, green/blue), diff color on back-face
- [*] we need to show geometry (wireframe)
- [*] generate docs

  This is a semi-big task - I don't think the actual work is difficult
  it's there are many nodes. I want your opinion before starting.

  Can we add a help system? The help system would be that each node has
  a [?] icon in the top right and maybe there is a help icon in the menu bar
  that leads to the help with a table of contents.

  The help would be at docs.html and the links would be something like
  `docs.html?topic=core/output`. Each topic would have

  * a description of what the node does
  * a table showing each input, its type, and a description
  * a table showing each output, its type, and a description
  * a sample graph (using the canvas) with the node and enough supporting nodes to show a preview
  * a sample preview, showing something that shows a result of the node.

    The layout might be something like

          +------------------+
          | header           |
          +------------------+
          |   name of node   |
          +--------+---------+
          | graph  | preview |
          +--------+---------+
          | inputs           |
          | outputs          |
          +------------------+

    If possible, the data needed to make this page should be present on
    the node's definition so clear it needs to be added when making a new node

    Instead of `docs.html?topic=<topic>` make it would be better to generate a page per topic
    in like `docs/nodes/<topic>`? Better for search engines?

- [*] use ramp texture for hemisphere? (no, but added ramp)
- [*] colorize should be N stop? Instead of 2 stop? 
- [*] edit in canvas updated all canvases, should only update LRU
- [*] double click subgraph, should only update LRU
- [*] deleting all nodes, adding back nodes, preview never pixels up core/output
- [*] simplest graph, cleanup, wrong order
- [*] fix edge - it's on object,not water.
- [*] foam color glows
- [*] color editor with alpha
- [*] query param for initial scene
- [*] query param to start with animation on
- [*] make foam color settable
- [*] save to URL
- [*] color control should use 0 to 1, not 0, 255 (optional? if so default to 1)
- [*] color control values should allow dragging like node numbers
- [*] color control should have toggle for HSL/RGB
- [*] list of nodes is too long, when canvas is shorter than screen you can not
  scroll though canvas.
- [*] fix scene-merge (use less)
  - example - forest has 3 scene-merge nodes where 1 would do.
- [*] better leaf preview

  Show the leaf shape in one color and the veins in another, same preview

- [*] make connection dots align with text
- [*] Canvas tab should show name of graph being edited - preview tab should show name of subgraph being viewed (same as vscode shows file being edited)
- [*] move asset view under canvas (25%) tall
- [*] use Levenshtein distance? - uses fuzzy search like VSCode.
- [*] Add "Add X" commands to Shift-Cmd/Ctrl-P?
  - add core/sphere
  - add leaf/skeleton
  - etc...
- [*] Select All (Cmd/Ctrl-A) should select in the current view, not HTML
  - preview = no-op?
  - asset = select all in folder?
  - canvas - select all nodes

- [*] 'f' frame needs to work in canvas
- [*] need to be able to size split
- [*] Need real menus probably

  Must handle diagonal drag to submenus.

- [*] highlight selected node
- [*] show names on nodes (editable)
- [*] seems like clicking on a node should select it?

  currently, to delete a node, you must drag select (hold shift). then
  delete. seems like click delete should work

- [*] grass
- [*] ridged-noise
- [*] bloom (too shallow? sun looks harsh like outline)
- [*] soft shadows
- [*] save/load
- [*] tone mapping
- [*] cleanup
- [*] fix colors of canvas controls
- [*] pinch to zoom
- [*] ask about setting ambient higher - added hemisphere lighting
- [*] drag node re-renders. (fixed)
- [*] edit button on node - need right click "open in new/other canvas"?
- [*] What is the (Active) thing? - Seems not needed
- [*] Need to save last active view for both graphs (viewport) and preview (camera) (ask LLM)
- [*] Asset view needs multiple select (move/cut/copy/paste)
- [*] selecting a graph in the asset view should not change the canvas view nor the preview
- [*] double clicking a graph should "open the graph" in the current/last active canvas or right click "open in canvas" or makes new one if none exist
- [*] right click asset and pick "open in preview" push in current/last preview or makes new one if none exist
- [*] subscene needs preview
- [*] add Ctrl-Shift-P
- [*] cut/copy/paste
- [*] duplicate
- [*] subscene needs edit button
- [*] frame subscenes
- [*] nodes need icons?
- [*] asset list view should be a table, not span
- [*] show type with name in asset view both icon and list
- [*] figure out UX for graph selection and scene selection? Not needed, - [*] scene merge needs N inputs
- [*] can not zoom out enough
- [*] render on demand - not constantly
- [*] make input and output nodes have a "drop here +" spot
  to auto add an input or output
- [*] put back the realtime editing
  currently there's a delay until the system responds.
- [*] Need to cache subgraphs - the tree subgraph generates a tree. Unless inputs change it doesn't need to be rebuilt.
- [*] cleanup resources
- [*] Make github action to publish on gh-pages
  Might need an import map?
- [*] texture nodes need preview - 
- [*] Need an asset hierarchy (folders)

  Like Unity, it should be a tree of folders and subgraphs.
  They can be listed as names or as icons. User can drag subgraphs
  from one folder to another as well as drag them into the current graph.

- [*] Need a window manager?

  Currently we have a vertically split window. Maybe we just need panes
  like VSCode and you can set each pane to show a graph or a preview or
  assets

- [*] Would like multiple windows

  If an webpage creates a window its accessible directly and can share a
  A WebGPU device so it seems this is not a hard thing to do. For real pro
  asset creation it's common to have 2 monitors so being able to create
  multiple windows is probably a must.

- [*] color the connections?
- [*] per graph canvas position
- [*] camera
  - [*] camera per scene
  - [*] fly?
- [*] need a node cleanup (re-layout)
- [*] use reverse-z
- [*] CSS classes
- [*] need undo/redo
- [*] node title areas should match output color?
- [*] align values?

  currently it's

  ```
  abc [--value--]
  defgh [-value-]
  ```

  should maybe be


  ```
  abc   [-value-]
  defgh [-value-]
  ```
- [*] frame selected
- [*] add github link


## --- old ---

This is a data definition and library for generating 3d models
and worlds from mostly procedural data.

- [ ] Generate a city (buildings, roads, street lamps, store fronts)
- [ ] Generate a biome (forest, desert, jungle, undersea)
- [ ] Generate plants/trees/rocks including leaves
- [ ] Generate terrain (mountains, valleys, rivers)

Inspiration taken from other node based systems

- [ ] Generating procedural textures
- [ ] Generating procedural geometry
  - [ ] simple solids (sphere, cube, triangle, cylinder ...)
  - [ ] tree structures (trees, plants)
  - [ ] modifiers (lathes, extrusions)
  - [ ] duplicators (in area, along paths or surfaces, ....)

## Constraints / Goals

This library's point is to make it possible to:

- [ ] Transmit instructions for large 3D models, environments with minimal data
- [ ] Generate a real time renderable (60fps) scene from procedural data quickly
- [ ] Generate AAA looking content
- [ ] Work in a web browser via WebGPU
- [ ] Be usable in non-browser environments

## Transmit instructions for large 3D models, environments with minimal data

   Ideally this means sending a few 100k of data and generating a detailed
   jungle, forest, city.

## Generate a real time renderable (60fps) scene from procedural data quickly

   This means the algorithms and techniques used should emphasize generating
   data efficiently on the GPU. For an entire jungle or city it might take
   2-3 minute to generate all of it. Ideally, it happens asynchronously and
   incrementally so the user can see the closest content instantly and see
   the world get filled in with more detail. 

## Generate AAA looking content

   Proof of concept would be a jungle, forest, and city looking as good
   as or close to a AAA game.
  
## Work in a web browser via WebGPU

   This emphasizes that techniques used should be designed to be efficient
   in a browser. One of the issues that needs solving for browser 3D is
   downloading assets. Generated assets can be one solution.

## Be usable in non-browser environments

   Although the initial implementation will be in WebGPU and TypeScript,
   ideally we should have C++ (Dawn), Python, and Rust (wgpu) implementations that
   interpret the same data

   It's possible we should start with Rust and use WebAssembly?

# Stretch Goals

- [ ] Generate humans
- [ ] Generate animals
- [ ] Generate clothing

Including body "bone" hierarchies and "bone" weights.

## Humans

Obviously tons of RPGs have character generators so it might not be too crazy to consider
what nodes or inputs it would take to build humans. Bodies might not be that hard. I have
no idea what to do for textures but it seems like their are procedural rules you can apply
to generate skin textures.

## Animals

Animals seem similar. Ideally nothing is hard coded but we can come up with the nodes and
settings needed to make 4 legged creatures, birds, snakes, lizard, fish, octopuses including
textures.

## Clothing

Clothing again seem like, given the right set of nodes, many types of clothing can be generated.
Shirts, pants, belts, jackets, shoes.

# Steps

1. Setup project to generate typescript library and
   interactive editor/viewer with tests (puppeteer)

2. Identify and categorize types of nodes needed

   - [ ] Geometry
   - [ ] Terrain (erosion, road integration, stream/river placement, situation aware rock/plant/tree placement)
   - [ ] Placement nodes (a dresser places N draws, which with handles. A window might have N/M dividers)
   - [ ] Texture generation nodes (patterns, noise, paths, ...)
   - [ ] Modifiers

2. Implement a base PBR type efficient renderer
3. Implement a UI for editing and connecting nodes.

   Nodes will need definitions so it's easy to represent
   and connect them in generic ways with typed inputs
   and outputs so you can only connect matching inputs
   to outputs.

3. Implement node systems

   - [ ] Geometry generation
   - [ ] Terrain generation
   - [ ] Texture generation

# Notes

* Perlin and Worley are currently always tiled. Do we need un-tiled?

  Claude says probably not

