import { Injectable } from "@spinajs/di";
import { _user } from "./index.js";
import { UserProfile, UserProfileProvider } from "./interfaces.js";
import { User } from "./models/User.js";

/**
 * Basic profile
 */
@Injectable(UserProfileProvider)
export class BasicProfileProvider implements UserProfileProvider {
    public async retrieve<T>(user: string | number | User): Promise<UserProfile<T>> {
        const u = await _user(user)();
        return new UserProfile(u)
    }

}