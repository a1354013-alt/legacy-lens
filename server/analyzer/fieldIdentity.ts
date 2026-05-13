export interface FieldIdentity {
  table: string;
  field: string;
}

export function buildFieldIdentityKey(identity: FieldIdentity) {
  return JSON.stringify({
    table: identity.table,
    field: identity.field,
  });
}

export function parseFieldIdentityKey(key: string): FieldIdentity {
  return JSON.parse(key) as FieldIdentity;
}
