module.exports = {
    "$id": "http://spinajs/example_js.schema.js",
    "title": "Product",
    "description": "A product from Acme's catalog",
    "type": "object",
    "properties": {
        "productId": {
            "description": "The unique identifier for a product",
            "type": "integer"
        }
    },
    "required": ["productId"]
}
