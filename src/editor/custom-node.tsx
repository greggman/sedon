import { Handle, Position, useConnection, type NodeProps } from '@xyflow/react';
import { useMemo } from 'react';
import type { InputDef, OutputDef } from '../core/node-def.js';
import { createCoreNodeRegistry } from '../nodes/index.js';
import { createCoreTypeRegistry } from '../core/types.js';

const nodes = createCoreNodeRegistry();
const types = createCoreTypeRegistry();

const HEADER_HEIGHT = 28;
const ROW_HEIGHT = 22;
const HANDLE_SIZE = 10;

const nodeStyle: React.CSSProperties = {
  background: '#2a2a35',
  border: '1px solid #555',
  borderRadius: 4,
  color: '#ddd',
  fontSize: 12,
  fontFamily: 'system-ui, sans-serif',
  minWidth: 160,
};

const headerStyle: React.CSSProperties = {
  height: HEADER_HEIGHT,
  padding: '0 10px',
  background: '#3a3a48',
  borderBottom: '1px solid #555',
  display: 'flex',
  alignItems: 'center',
  fontWeight: 600,
};

const rowStyle: React.CSSProperties = {
  height: ROW_HEIGHT,
  padding: '0 10px',
  display: 'flex',
  alignItems: 'center',
};

function typeColor(typeId: string): string {
  return types.get(typeId)?.color ?? '#888';
}

interface TypedHandleProps {
  socketName: string;
  socketType: string;
  side: 'input' | 'output';
  rowIndex: number;
  totalRows: number;
}

function TypedHandle({ socketName, socketType, side, rowIndex }: TypedHandleProps) {
  const connection = useConnection();
  const color = typeColor(socketType);

  // Highlight when this handle could accept the in-progress connection from
  // somewhere else. The dragging endpoint connects from a source to a target,
  // so a target handle highlights iff the in-progress source's type is
  // compatible with this handle's type, and a source handle highlights iff
  // this output's type is compatible with the dragging target's input type.
  let matches = false;
  if (connection.inProgress && connection.fromHandle) {
    const fromType = (connection.fromHandle as { socketType?: string }).socketType;
    if (fromType) {
      if (side === 'input' && connection.fromHandle.type === 'source') {
        matches = types.isCompatible(fromType, socketType);
      } else if (side === 'output' && connection.fromHandle.type === 'target') {
        matches = types.isCompatible(socketType, fromType);
      }
    }
  }

  const top = HEADER_HEIGHT + rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2;

  const style: React.CSSProperties = {
    top,
    width: HANDLE_SIZE,
    height: HANDLE_SIZE,
    background: color,
    border: '1px solid #1a1a1f',
    boxShadow: matches ? `0 0 0 3px ${color}55, 0 0 8px ${color}` : 'none',
  };

  // Tag the handle with its socket type for the other handles' useConnection()
  // checks to read.
  return (
    <Handle
      type={side === 'input' ? 'target' : 'source'}
      position={side === 'input' ? Position.Left : Position.Right}
      id={socketName}
      data-socket-type={socketType}
      style={style}
    />
  );
}

export function CustomNode({ data }: NodeProps) {
  const kind = typeof data['kind'] === 'string' ? data['kind'] : undefined;
  const def = useMemo(() => (kind ? nodes.get(kind) : undefined), [kind]);

  if (!def) {
    return <div style={{ ...nodeStyle, padding: 8 }}>unknown: {kind ?? '(no kind)'}</div>;
  }

  const inputs: InputDef[] = def.inputs;
  const outputs: OutputDef[] = def.outputs;
  const totalRows = inputs.length + outputs.length;

  return (
    <div style={nodeStyle}>
      <div style={headerStyle}>{def.id}</div>

      {inputs.map((input, i) => (
        <TypedHandle
          key={`h-in-${input.name}`}
          socketName={input.name}
          socketType={input.type}
          side="input"
          rowIndex={i}
          totalRows={totalRows}
        />
      ))}
      {inputs.map((input) => (
        <div key={`row-in-${input.name}`} style={rowStyle} title={input.type}>
          {input.name}
        </div>
      ))}

      {outputs.map((output, i) => (
        <TypedHandle
          key={`h-out-${output.name}`}
          socketName={output.name}
          socketType={output.type}
          side="output"
          rowIndex={inputs.length + i}
          totalRows={totalRows}
        />
      ))}
      {outputs.map((output) => (
        <div
          key={`row-out-${output.name}`}
          style={{ ...rowStyle, justifyContent: 'flex-end' }}
          title={output.type}
        >
          {output.name}
        </div>
      ))}
    </div>
  );
}
