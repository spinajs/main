import { Injectable } from '@spinajs/di';
import { FormFileUploader } from "@spinajs/http";
 
@Injectable(FormFileUploader)
export class HttpLazyFileUploader extends FormFileUploader
{

}