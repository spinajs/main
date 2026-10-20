import { User } from './models/User.js';

export class UserProfile<T> { 
  public User: User;
  public AdditionalData?: T;

  public constructor(user : User, data? :  T){ 
    this.User = user;
    this.AdditionalData = data;
  }
}

/**
 * Base class for user profile retrieval
 * 
 * User can have not only basic information, but some extended one
 * eg. user profile have information about number of posts, sales etc.
 */
export abstract class UserProfileProvider { 
  public abstract retrieve<T>(user : string | number  | User) : Promise<UserProfile<T>>;
}
