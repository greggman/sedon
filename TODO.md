# Sedon

--- new ---

* WGSL snippet node - meta data for types (quat vs vec4f vs color) but parse for defaults
* is core/grid a valid node. maybe should be list of colors with +/- to add to list?
* is there a list/array entry type
* solid-color should just be color (special case or give it 2 outputs)
* editable texture? a node with a pixel editor?
* texture nodes need preview
* texture size should be drop down (64x64, 128x128, 256x256, 512x512, etc, with "custom" as option)
* having color nodes is gross - solutions
  (1) color inputs, like numbers, have a color
  (2) color bank (a node with N colors and N outputs, maybe with labels)
* need preview always - even if bad inputs (example heightfield)
* let you pull of an input
* add help icon at top right of each node (or bottom left as there is space)
  should be link to docs. Generate docs for each node. Docs should have live
  sample. Sample could be specified in URL as in `url?json={..}` or `url?deflate=base64`
* allow drag and drop of scene
* name scene .sedon
* need "new scene"
  * verify before deleting work
  * offer various kinds of starting scenes
* need to be able to drag select nodes to move as a group
* need a way to make a point cloud with more constraints
  * example: want random x,y,z but want x == z

    solutions?:

    * use 2 float clouds (xz, y) and combine into xyz point-cloud
    * custom WGSL point cloud node
    * after the fact modifier - make xyz cloud -> filter node(s) 
    * other

    Not sure if we should have one of these are all of them
* use reverse-z
* CSS classes
* align values?

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


* node title areas should match output color?
  * some nodes 
* nodes should be nameable - and searchable
* need a node cleanup (re-layout)
* material previews should use track camera, not orbit
* preview sphere should be larger 
* need undo/redo
* touch support? (iPad) - maybe iphone
* need to be able to size split
* support HDR output
* colorize should be N stop? Instead of 2 stop? 
* camera
  * orbit vs track control (option)
  * frame
  * ortho
  * fly?


--- old ---

This is a data definition and library for generating 3d models
and worlds from mostly procedural data.

* Generate a city (buildings, roads, street lamps, store fronts)
* Generate a biome (forest, desert, jungle, undersea)
* Generate plants/trees/rocks including leaves
* Generate terrain (mountains, valleys, rivers)

Inspiration taken from other node based systems

* Generating procedural textures
* Generating procedural geometry
  * simple solids (sphere, cube, triangle, cylinder ...)
  * tree structures (trees, plants)
  * modifiers (lathes, extrusions)
  * duplicators (in area, along paths or surfaces, ....)

## Constraints / Goals

This library's point is to make it possible to:

* Transmit instructions for large 3D models, environments with minimal data
* Generate a real time renderable (60fps) scene from procedural data quickly
* Generate AAA looking content
* Work in a web browser via WebGPU
* Be usable in non-browser environments

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

* Generate humans
* Generate animals
* Generate clothing

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

   * Geometry
   * Terrain (erosion, road integration, stream/river placement, situation aware rock/plant/tree placement)
   * Placement nodes (a dresser places N draws, which with handles. A window might have N/M dividers)
   * Texture generation nodes (patterns, noise, paths, ...)
   * Modifiers

2. Implement a base PBR type efficient renderer
3. Implement a UI for editing and connecting nodes.

   Nodes will need definitions so it's easy to represent
   and connect them in generic ways with typed inputs
   and outputs so you can only connect matching inputs
   to outputs.

3. Implement node systems

   * Geometry generation
   * Terrain generation
   * Texture generation

