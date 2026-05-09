export function createScenePipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
  shaderCode: string,
): GPURenderPipeline {
  const module = device.createShaderModule({ code: shaderCode });

  return device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module,
      buffers: [
        // position (vec3f)
        {
          arrayStride: 12,
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
        },
        // normal (vec3f)
        {
          arrayStride: 12,
          attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }],
        },
        // uv (vec2f)
        {
          arrayStride: 8,
          attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }],
        },
      ],
    },
    fragment: {
      module,
      targets: [{ format }],
    },
    primitive: { cullMode: 'back' },
    depthStencil: {
      format: 'depth24plus',
      depthCompare: 'less',
      depthWriteEnabled: true,
    },
  });
}
