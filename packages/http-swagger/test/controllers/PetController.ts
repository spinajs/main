import { BaseController, BasePath, Get, Post, Del, Put, Patch, Ok, Body, Query, Param } from '@spinajs/http';

/**
 * Pet store management controller.
 * Provides CRUD operations for managing pets.
 * @tags Pets
 */
@BasePath('pets')
export class PetController extends BaseController {
  /**
   * List all pets
   * Returns a paginated list of all available pets in the store.
   * @param page Page number for pagination
   * @param limit Number of items per page
   * @returns Array of pet objects
   * @example
   * <caption>Successful response</caption>
   * [{"id": 1, "name": "Buddy", "type": "dog"}, {"id": 2, "name": "Whiskers", "type": "cat"}]
   */
  @Get('/')
  public async listPets(@Query() page: number, @Query() limit: number) {
    return new Ok({
      page,
      limit,
      data: [
        { id: 1, name: 'Buddy', type: 'dog' },
        { id: 2, name: 'Whiskers', type: 'cat' },
      ],
    });
  }

  /**
   * Get a pet by ID
   * Retrieves detailed information about a specific pet.
   * @param id The unique pet identifier
   * @returns A pet object with full details
   * @response 400 Invalid ID supplied
   * @response 404 Pet not found
   * @response 500 Internal server error
   */
  @Get(':id')
  public async getPet(@Param() id: number) {
    return new Ok({ id, name: 'Buddy', type: 'dog' });
  }

  /**
   * Create a new pet
   * Adds a new pet to the store inventory.
   * @param data The pet data to create
   * @returns The created pet object with assigned ID
   * @example
   * <caption>Create pet request</caption>
   * {"name": "Rex", "type": "dog", "age": 3}
   */
  @Post('/')
  public async createPet(@Body() data: object) {
    return new Ok({ id: 3, ...data });
  }

  /**
   * Update an existing pet
   * @param id The pet ID to update
   * @param data Updated pet data
   * @returns The updated pet object
   */
  @Put(':id')
  public async updatePet(@Param() id: number, @Body() data: object) {
    return new Ok({ id, ...data });
  }

  /**
   * Delete a pet
   * Removes a pet from the store.
   * @param id The pet ID to delete
   * @deprecated Use archivePet instead
   */
  @Del(':id')
  public async deletePet(@Param() id: number) {
    return new Ok({ deleted: id });
  }

  /**
   * Partially update a pet
   * @param id The pet ID
   * @param data Fields to update
   * @returns The patched pet object
   * @tags Pets, Admin
   */
  @Patch(':id')
  public async patchPet(@Param() id: number, @Body() data: object) {
    return new Ok({ id, ...data });
  }

  /**
   * Find a pet by name (demonstrates return type inference)
   * Returns availability status for a named pet.
   * @param name The pet name to search for
   */
  @Get('find/:name')
  public async findPet(@Param() name: string): Promise<{ id: number; name: string; available: boolean }> {
    return { id: 1, name, available: true } as any;
  }

  /**
   * List available pets (demonstrates array return type inference)
   * @param type Filter by pet type
   */
  @Get('available')
  public async listAvailable(@Query() type: string): Promise<Array<{ id: number; name: string; type: string }>> {
    return [{ id: 1, name: 'Buddy', type }] as any;
  }
}
