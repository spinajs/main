import { AsyncService } from '@spinajs/di';
/**
 * Wrapper class for commander  https://github.com/tj/commander.js
 * To declare opions & arguments use decorators. This class is resolved
 * when cli module is created.
 *
 * It allows to use all features that spinajs provides eg. DI, logging, intl support etc.
 * inside command functions without hassle.
 */
export class CliCommand extends AsyncService {
    /**
     * Executed on command creation, used when you need to
     * use advanced stuff from commander lib
     *
     * Decorators provide only basic command args & options declarations,
     * and are used only for simle use cases
     *
     * @param c - commander command object
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-function
    onCreation(_command) { }
    /**
     * Commander `preAction` hook — runs before this command's action.
     *
     * @param thisCommand - the command the hook was registered on
     * @param actionCommand - the command whose action is about to run
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-function
    onPreAction(_thisCommand, _actionCommand) { }
    /**
     * Commander `postAction` hook — runs after this command's action.
     *
     * @param thisCommand - the command the hook was registered on
     * @param actionCommand - the command whose action has run
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-function
    onPostAction(_thisCommand, _actionCommand) { }
}
//# sourceMappingURL=interfaces.js.map