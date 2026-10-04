// Spike: create a link, update it, and attempt a forged update, for both
// RSA (Arweave JWK) and Ed25519 (Solana-style) signers. Writes results.json.
import fs from 'node:fs';
import { TurboFactory } from '@ardrive/turbo-sdk';
import Arweave from 'arweave';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const APP = 'PermaPath-Spike';
const arweave = Arweave.init({});

async function rsaClient() {
  const jwk = await arweave.wallets.generate();
  return { kind: 'rsa', keyLen: JSON.stringify(jwk).length, turbo: TurboFactory.authenticated({ privateKey: jwk }) };
}

function edClient() {
  const kp = nacl.sign.keyPair();
  const secret = bs58.encode(kp.secretKey);
  return { kind: 'ed25519', keyLen: secret.length, turbo: TurboFactory.authenticated({ privateKey: secret, token: 'solana' }) };
}

async function post(client, tags, data) {
  const t0 = Date.now();
  const res = await client.turbo.upload({
    data,
    dataItemOpts: { tags: [{ name: 'App-Name', value: APP }, ...tags] },
  });
  return { id: res.id, owner: res.owner, ms: Date.now() - t0 };
}

const results = [];
for (const make of [rsaClient, edClient]) {
  const owner = await make();
  const attacker = await make();
  const genesis = await post(owner, [
    { name: 'Type', value: 'link' },
    { name: 'Destination', value: 'https://example.com/v0' },
    { name: 'Seq', value: '0' },
  ], 'https://example.com/v0');
  const update = await post(owner, [
    { name: 'Type', value: 'update' },
    { name: 'Link', value: genesis.id },
    { name: 'Destination', value: 'https://example.com/v1' },
    { name: 'Seq', value: '1' },
  ], 'https://example.com/v1');
  const forged = await post(attacker, [
    { name: 'Type', value: 'update' },
    { name: 'Link', value: genesis.id },
    { name: 'Destination', value: 'https://evil.example/' },
    { name: 'Seq', value: '99' },
  ], 'https://evil.example/');
  const r = { kind: owner.kind, keyLen: owner.keyLen, genesis, update, forged, postedAt: Date.now() };
  console.log(JSON.stringify(r));
  results.push(r);
}
fs.writeFileSync('results.json', JSON.stringify(results, null, 2));
