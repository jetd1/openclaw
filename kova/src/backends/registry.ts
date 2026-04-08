import { multipassBackend } from "./multipass.js";
import { qaBackend } from "./qa.js";
import {
  kovaRunTargets,
  type KovaBackend,
  type KovaBackendId,
  type KovaRunTarget,
} from "./types.js";

const kovaBackends: KovaBackend[] = [qaBackend, multipassBackend];

export function listKovaTargets() {
  return [...kovaRunTargets];
}

export function listKovaBackends(target?: KovaRunTarget) {
  return kovaBackends.filter((backend) => (target ? backend.supportsTarget(target) : true));
}

export function resolveKovaBackend(target: KovaRunTarget, backendId?: KovaBackendId) {
  const backend = listKovaBackends(target).find((candidate) => {
    if (!candidate.supportsTarget(target)) {
      return false;
    }
    return backendId ? candidate.id === backendId : true;
  });
  if (!backend) {
    throw new Error(
      `no Kova backend registered for target: ${target}${backendId ? ` (${backendId})` : ""}`,
    );
  }
  return backend;
}
