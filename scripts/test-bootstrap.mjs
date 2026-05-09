import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(pathToFileURL('./scripts/wgsl-loader.mjs').href, pathToFileURL('./').href);
