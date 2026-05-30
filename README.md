# Sedon

Procedural 3D content generator built around a node graph. (super alpha)

<img src="images/sedon-screenshot.jpg" />

(sedon = nodes spelled backward - need a better name!)

[Live](https://greggman.github.io/sedon/?anim=1)

Warning: Anything you make is not *really* saveable and the format
is likely to change. Though, if you make something good looking
and performant, you can save it as a URL, up to a certain size and
post in an issue maybe I can included it.

Note: No idea how far I'll take this. The entire point was I wanted to
see big content from small data since IMO that's one of the biggest
reasons 3D isn't bigger on the web. for example, the forest above is 9k
gzipped. I don't know if this is a solution but I thought it might be fun to try to generate a close to AAA 3D web demo of a forest, jungle, dessert, city.

## Vibe Coding

This is vibe coded. Yes, I supervise and question implementation
choices but I've written near zero lines of code in this repo.

I know it's only going to get better but I'm blown away. When I
say it's vibe coded I mean it! Other than React and ReactFlow
there are basically no libraries. And honestly I don't really know
what `ReactFlow` brings to the table because it's not actually
doing node layout. It seems to only be providing the connectors
and zoom/pan across a canvas. All the actual data flow etc, is
entire written by Claude.

Further, every shader, every effect, and every graph has been
created by Claude so far. I've tweaked a few numbers or colors
but Claude built all the sample graphs, all the compute and
render pipelines, etc... I worked with Claude to add caching
and tests so that ideally data is generated once and kept around.
I worked with claude to add the preview, camera controls, fly controls,
undo/redo, command patterns, filters, all the previews, etc.
It's incredible honestly.

I'd say, up to this point, ~4 weeks in, about 50% of the time
has been spent on UI issues (adding menus, adding a command palette,
adding multiple views, pop-out windows,
adding previews in nodes, fixing related caching bugs) and 50%
in the actual "core" nodes, rendering.

It's been crazy, I ask for bloom, it writes it. I ask for
Rayleigh scattering, it writes it. I ask for height-map
erosion, water, reflections, refraction, whatever, it writes
it. No frameworks, no existing 3d engine, ask for it and
generally, a few minutes later it's working.

Some things I had to help it with. I had it add WebGPU labels
at one point so it could figure out which WebGPU resources
were related to WebGPU errors. I had it write puppeteer tests
when it was having trouble finding bugs without actual WebGPU.
A few times it had trouble finding a bug and I'd suggest
making a smaller test case and using that to track it down.
I also suggested it make a Mock WebGPU api for testing non
WebGPU related flow.

## License: MIT

