// import { InvalidOperation } from '@spinajs/exceptions';
// import { BaseController, BasePath, Post, Body, Ok, Get, Unauthorized, Header, Policy } from '@spinajs/http';
// import { FederatedAuthProvider } from '@spinajs/rbac';
// import { Autoinject } from '@spinajs/di';
// import _ from 'lodash';
// import { AllowFederatedLoginPolicy } from '../policies/AllowFederatedLoginPolicy.js';

// @BasePath('user/auth')
// export class LoginController extends BaseController {
//   @Autoinject(FederatedAuthProvider)
//   protected FederatedLoginStrategies: FederatedAuthProvider<any>[];

//   @Post('federated-login')
//   @Policy(AllowFederatedLoginPolicy)
//   public async loginFederated(@Body() credentials: unknown, @Header('Host') caller: string) {
//     const strategy = this.FederatedLoginStrategies.find((x) => x.callerCheck(caller));
//     if (!strategy) {
//       throw new InvalidOperation(`No auth stragegy registered for caller ${caller}`);
//     }

//     const result = await strategy.authenticate(credentials);
//     if (!result.Error) {
//       // proceed with standard authentication
//       return await this.authenticate(result.User);
//     }

//     return new Unauthorized(result.Error);
//   }

//   /**
//    *
//    * Api call for listing avaible federated login strategies
//    *
//    * @returns response with avaible login strategies
//    */
//   @Get()
//   @Policy(NotLoggedPolicy)
//   @Policy(AllowFederatedLoginPolicy)
//   public async federatedLoginList() {
//     return new Ok(this.FederatedLoginStrategies.map((x) => x.Name));
//   }
// }
