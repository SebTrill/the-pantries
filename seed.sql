-- Starter data: a handful of common substitutions so the library isn't empty on day one.
INSERT OR IGNORE INTO categories (name) VALUES
 ('Breakfast'),('Lunch'),('Dinner'),('Dessert'),('Soup'),('Side'),('Snack'),('Drink'),('Vegetarian'),('Quick & Easy');

INSERT INTO substitutions (id,recipe_id,ingredient,substitute,notes,created_at) VALUES
 ('sub001',NULL,'Buttermilk','1 cup milk + 1 tbsp lemon juice','Let sit 5 minutes before using.',1),
 ('sub002',NULL,'Egg','1 tbsp ground flaxseed + 3 tbsp water','Good for baking; let gel 5 minutes.',2),
 ('sub003',NULL,'Butter','Coconut oil','Use a 1:1 ratio.',3),
 ('sub004',NULL,'Heavy Cream','Evaporated milk','Slightly lighter texture.',4),
 ('sub005',NULL,'Soy Sauce','Coconut aminos','Lower sodium, slightly sweeter.',5),
 ('sub006',NULL,'Milk','Oat milk','Neutral flavor, works in most baking.',6),
 ('sub007',NULL,'All-Purpose Flour','1:1 gluten-free baking flour','Best with a binder like xanthan gum.',7),
 ('sub008',NULL,'Vegetable Oil','Avocado oil','High smoke point, good for stir-fry.',8),
 ('sub009',NULL,'Brown Sugar','White sugar + 1 tbsp molasses','Per cup of sugar.',9),
 ('sub010',NULL,'Fresh Basil','Dried basil','Use 1/3 the amount.',10),
 ('sub011',NULL,'Vegetable Broth','Chicken broth','No longer vegetarian.',11),
 ('sub012',NULL,'Garlic','Garlic powder','1/8 tsp powder per clove.',12),
 ('sub013',NULL,'Sour Cream','Plain Greek yogurt','1:1, slightly tangier.',13),
 ('sub014',NULL,'Cornstarch','2 tbsp all-purpose flour','Per 1 tbsp cornstarch.',14),
 ('sub015',NULL,'White Sugar','Honey','Use 3/4 cup honey per cup sugar; reduce other liquid by 1/4 cup.',15);
