import { BaseController, BasePath, Del, Get, Ok, Patch, Post, Put, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import type { Principal } from '@spinajs/authz';
import '@spinajs/authz-http';

/** The probe route of the users http app: every method, no policy, after every middleware. */
export const PROBE_PATH = 'users-http-probe';

let hits = 0;

export function resetProbeHits(): void {
  hits = 0;
}

// The kit's ProbeBody fields only: `identity` holds the users model. The anonymous principal is the kit's `null`.
function probePrincipal(p: Principal | undefined) {
  if (!p || p.authenticated === false) return null;
  return {
    type: p.type,
    id: p.id,
    source: p.source,
    ...(p.authn ? { authn: p.authn } : {}),
    ...(p.ceiling ? { ceiling: p.ceiling } : {}),
    ...(p.onBehalfOf ? { onBehalfOf: { type: p.onBehalfOf.type, id: p.onBehalfOf.id } } : {}),
    ...(p.delegation ? { delegation: p.delegation } : {}),
    attributes: p.attributes,
  };
}

/** The kit's ProbeBody over `req.storage.Principal`, the principal authz-http's PrincipalMiddleware took from authn. */
function probeBody(req: Request) {
  hits++;
  return { principal: probePrincipal(req.storage.Principal), clientIp: req.storage.ClientIp ?? null, hits };
}

@BasePath(PROBE_PATH)
export class UsersHttpProbeController extends BaseController {
  @Get('/')
  public async probeGet(@Req() req: Request) {
    return new Ok(probeBody(req));
  }

  @Post('/')
  public async probePost(@Req() req: Request) {
    return new Ok(probeBody(req));
  }

  @Put('/')
  public async probePut(@Req() req: Request) {
    return new Ok(probeBody(req));
  }

  @Patch('/')
  public async probePatch(@Req() req: Request) {
    return new Ok(probeBody(req));
  }

  @Del('/')
  public async probeDelete(@Req() req: Request) {
    return new Ok(probeBody(req));
  }
}
