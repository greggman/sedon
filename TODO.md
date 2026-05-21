# Sedon

--- steps ---

- [ ] grass
- [*] ridged-noise
- [*] bloom (too shallow? sun looks harsh like outline)
- [*] soft shadows
- [*] save/load
- [*] tone mapping
- [*] cleanup

--- new ---

- [ ] The readback in heightfield-to-mesh is unacceptable. There should be no reason to read back the data from the GPU. Keep it on the GPU. Do the heightMapToMesh on the GPU. Besides, we need a
terrain renderer that tessellates the terrain
based on distance from the camera. 
- [ ] frame selected
- [ ] add github link
- [ ] copy/copy/paste nodes
- [ ] forest nodes are black
- [ ] label all GPU resources (buffers, textures, samplers, pipelines, bindgroups, bingrouplayouts, encoders, renderPassEncoders, computePassEncoders)
- [ ] need to be able to set default on subgraph-input
- [ ] highlight selected node
- [ ] show names on nodes (editable)
- [ ] leaf/skeleton needs better preview
- [*] drag node re-renders. Why?
- [ ] future nodes
- [ ] edit button on node - need right click "open in new/other canvas"?
- [ ] add UI tests
- [ ] isTexture2D and related seems brittle
- [*] What is the (Active) thing? - Seems not needed
- [*] Need to save last active view for both graphs (viewport) and preview (camera) (ask LLM)
- [*] Asset view needs multiple select (move/cut/copy/paste)
- [*] selecting a graph in the asset view should not change the canvas view nor the preview
- [*] double clicking a graph should "open the graph" in the current/last active canvas or right click "open in canvas" or makes new one if none exist
- [*] right click asset and pick "open in preview" push in current/last preview or makes new one if none exist
- [ ] left/skeleton needs to start from bottom center?
- [*] subscene needs preview
- [ ] too many previews?
- [*] add Ctrl-Shift-P
- [*] cut/copy/paste
- [*] duplicate
- [*] subscene needs edit button
- [*] frame subscenes
- [*] nodes need icons?
- [ ] scene-merge or somewhere should probably have TRS hierarchy and let you select nodes and drag to move in preview
- [*] asset list view should be a table, not span
- [ ] divider between folders and content needs to be slidable
- [*] show type with name in asset view both icon and list
- [*] figure out UX for graph selection and scene selection? Not needed, use asset view
- [ ] design should not be "extra inputs". It should be "array of input name,type"
- [*] scene merge needs N inputs
- [*] can not zoom out enough
- [*] render on demand - not constantly
- [ ] move the WebGPU parts to a worker
- [*] make input and output nodes have a "drop here +" spot
  to auto add an input or output
- [*] put back the realtime editing
  currently there's a delay until the system responds.
- [*] Need to cache subgraphs - the tree subgraph generates a tree. Unless inputs change it doesn't need to be rebuilt.
- [*] cleanup resources
- [*] Make github action to publish on gh-pages
  Might need an import map?
- [ ] seems like clicking on a node should select it?

  currently, to delete a node, you must drag select (hold shift). then
  delete. seems like click delete should work

- [ ] need a better UI than 3 numbers for setting a direction 
- [ ] change sky to use a lookup table for speed - need to recompute
  when the sun changes.
- [ ] WGSL snippet node - meta data for types (quat vs vec4f vs color) but parse for defaults
- [ ] is core/grid a valid node. maybe should be list of colors with +/- to add to list?
- [ ] is there a list/array entry type
- [ ] solid-color should just be color (special case or give it 2 outputs)
- [ ] editable texture? a node with a pixel editor?
- [*] texture nodes need preview - 
- [ ] texture size should be drop down (64x64, 128x128, 256x256, 512x512, etc, with "custom" as option)
- [ ] having color nodes is gross - solutions
  - [*] color inputs, like numbers, have a color
  - [ ] color bank (a node with N colors and N outputs, maybe with labels)
- [ ] need preview always - even if bad inputs (example heightfield)
- [ ] let you pull off an input (?)
  prefs because easy to break when trying to move node
- [ ] add help icon at top right of each node (or bottom left as there is space)
  should be link to docs. Generate docs for each node. Docs should have live
  sample. Sample could be specified in URL as in `url?json={..}` or `url?deflate=base64` or `url?src=url` 
- [ ] allow drag and drop of scene file
- [ ] name scene .sedon
- [ ] need "new scene"
  - [ ] verify before deleting work
  - [ ] offer various kinds of starting scenes
- [ ] need a way to make a point cloud with more constraints
  - [ ] example: want random x,y,z but want x == z

    solutions?:

    - [ ] use 2 float clouds (xz, y) and combine into xyz point-cloud
    - [ ] custom WGSL point cloud node
    - [ ] after the fact modifier - make xyz cloud -> filter node(s) 
    - [ ] other

    Not sure if we should have one of these are all of them

- [ ] Need real menus probably

  Must handle diagonal drag to submenus.

- [ ] Need an asset hierarchy (folders)

  Like Unity, it should be a tree of folders and subgraphs.
  They can be listed as names or as icons. User can drag subgraphs
  from one folder to another as well as drag them into the current graph.

- [ ] Need a window manager?

  Currently we have a vertically split window. Maybe we just need panes
  like VSCode and you can set each pane to show a graph or a preview or
  assets

- [ ] Would like multiple windows

  If an webpage creates a window its accessible directly and can share a
  A WebGPU device so it seems this is not a hard thing to do. For real pro
  asset creation it's common to have 2 monitors so being able to create
  multiple windows is probably a must.

- [ ] Probably need an "Inspector"

  It would show all the inputs in a node, some with better
  UIs?

- [ ] nodes should be nameable - and searchable
- [ ] material previews should use track camera, not orbit
- [ ] preview sphere should be larger 
- [ ] touch support? (iPad) - maybe iphone
- [ ] need to be able to size split
- [ ] support HDR output
- [ ] colorize should be N stop? Instead of 2 stop? 
- [ ] import png, jpg, webp
- [ ] import gltf
  Need to decide how to import. Seems like rather than the entire scene
  you should be able to reference individual assets (models, textures, materials).
  That suggests the output from a subscene should maybe be more complex?
  Or, it should import the gLTF as the collection of its parts as well as a scene
  that uses all of them. So they'd show up in the asset tree as like folders

- [ ] camera
  - [ ] orbit vs track control (option)
  - [ ] frame
  - [ ] ortho
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

--- old ---

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

