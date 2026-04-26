export const b64 = {
  encode: (buf) =>
    btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, ""),

  decode: (str) => {
    str = str.replace(/-/g, "+").replace(/_/g, "/");
    while (str.length % 4) str += "=";
    return Uint8Array.from(atob(str), (c) => c.charCodeAt(0)).buffer;
  },
};

export function decodeOptions(val) {
  try {
    if (typeof val === "string") return b64.decode(val);
    if (Array.isArray(val)) return val.map(decodeOptions);
    if (val && typeof val === "object") {
      return Object.fromEntries(
        Object.entries(val).map(([k, v]) => [k, decodeOptions(v)]),
      );
    }
    return val;
  } catch {
    return val;
  }
}

export function encodeCredential(cred) {
  try {
    const r = cred.response;
    const encoded = {
      id: cred.id,
      rawId: b64.encode(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: b64.encode(r.clientDataJSON),
        ...(r.attestationObject != null
          ? { attestationObject: b64.encode(r.attestationObject) }
          : {
            authenticatorData: b64.encode(r.authenticatorData),
            signature: b64.encode(r.signature),
            userHandle: r.userHandle ? b64.encode(r.userHandle) : null,
          }),
      },
    };
    if (cred.authenticatorAttachment) {
      encoded.authenticatorAttachment = cred.authenticatorAttachment;
    }
    if (typeof cred.getTransports === "function") {
      encoded.response.transports = cred.getTransports();
    }
    return encoded;
  } catch (err) {
    console.error("encodeCredential error:", err);
    throw err;
  }
}
