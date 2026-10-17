import { sortEnums } from './swagger-document';

describe('sortEnums', () => {
  it('sorts every enum, however deep, with null last', () => {
    const doc = {
      components: {
        schemas: {
          Notice: {
            properties: {
              kind: { type: 'string', enum: ['task_paused', 'spend_reset'] },
              qa: { enum: [null, 'rejected', 'accepted'] },
              list: { type: 'array', items: { enum: ['b', 'a'] } },
            },
          },
        },
      },
      paths: {
        '/x': { get: { parameters: [{ schema: { enum: ['z', 'y'] } }] } },
      },
    };

    sortEnums(doc);

    const props = doc.components.schemas.Notice.properties;
    expect(props.kind.enum).toEqual(['spend_reset', 'task_paused']);
    expect(props.qa.enum).toEqual(['accepted', 'rejected', null]);
    expect(props.list.items.enum).toEqual(['a', 'b']);
    expect(doc.paths['/x'].get.parameters[0].schema.enum).toEqual(['y', 'z']);
  });

  it('gives the same result whatever order the values arrived in', () => {
    const a = sortEnums({ enum: ['qa', 'chat', 'plan'] });
    const b = sortEnums({ enum: ['plan', 'qa', 'chat'] });
    expect(a).toEqual(b);
  });

  it('leaves everything that is not an enum alone', () => {
    const doc = { required: ['b', 'a'], properties: { b: {}, a: {} } };
    sortEnums(doc);
    expect(doc.required).toEqual(['b', 'a']);
    expect(Object.keys(doc.properties)).toEqual(['b', 'a']);
  });
});
