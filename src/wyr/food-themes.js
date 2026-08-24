const normalize = value => String(value || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const THEME_FILLER = new Set(['this', 'or', 'that', 'the', 'a', 'an', 'your', 'my', 'ultimate', 'perfect', 'dream', 'favorite', 'build', 'choose', 'create', 'make', 'pick']);

// Removing presentation-only filler makes titles such as "Build Your Ultimate Taco Night" and
// "Build Your Taco Night" collide. The DB UNIQUE constraint on this key is the concurrency-safe
// final duplicate guard.
export const canonicalFoodThemeKey = title => normalize(title).split(' ').filter(word => !THEME_FILLER.has(word)).join('-');

const option = text => ({ text, searchQuery: `${text} food photo` });
const question = (optionA, optionB) => ({ category: 'food', optionA: option(optionA), optionB: option(optionB) });
const theme = (title, hookTtsText, pairs) => ({ themeKey: canonicalFoodThemeKey(title), title, hookTtsText, questions: pairs.map(pair => question(...pair)) });

// Static DB seed data only. These are inserted through the existing question validation path;
// they are never selected from this array directly at runtime.
export const FOOD_THEME_SEEDS = Object.freeze([
  theme('Build Your Breakfast', 'Build your breakfast.', [
    ['Orange', 'Banana'], ['Croissant', 'Bagel'], ['Bacon', 'Sausage'], ['Frittata', 'Omelette'],
    ['Pancakes', 'French Toast'], ['Waffles', 'Cinnamon Roll'], ['Cereal', 'Granola'],
    ['Coffee', 'Smoothie'], ['Muffin', 'Danish'], ['Biscuit', 'Toast'],
  ]),
  theme('Choose Your Dessert', 'Choose your dessert.', [
    ['Ice Cream', 'Gelato'], ['Brownies', 'Cookies'], ['Cheesecake', 'Cannoli'],
    ['Tiramisu', 'Baklava'], ['Cupcake', 'Donut'], ['Apple Pie', 'Banana Bread'],
    ['Pudding', 'Custard'], ['Macarons', 'Churros'], ['Cobbler', 'Parfait'],
  ]),
  theme('Choose Your Comfort Food', 'Choose your comfort food.', [
    ['Mac and Cheese', 'Grilled Cheese'], ['Fried Chicken', 'Chicken Wings'], ['Mashed Potatoes', 'French Fries'],
    ['Pizza', 'Lasagna'], ['Ramen', 'Tomato Soup'], ['Cheeseburger', 'Hot Dog'],
    ['Garlic Bread', 'Cornbread'], ['Meatloaf', 'Casserole'], ['Chili', 'Stew'],
  ]),
  theme('Plan Your Pizza Night', 'Plan your pizza night.', [
    ['Pepperoni Pizza', 'Margherita Pizza'], ['Hawaiian Pizza', 'BBQ Chicken Pizza'], ['Mushroom Pizza', 'Sausage Pizza'],
    ['Buffalo Chicken Pizza', 'Cheeseburger Pizza'], ['White Pizza', 'Pesto Pizza'], ['Deep Dish Pizza', 'Thin Crust Pizza'],
    ['Veggie Pizza', 'Meatball Pizza'], ['Breakfast Pizza', 'Taco Pizza'], ['Truffle Pizza', 'Garlic Pizza'],
  ]),
  theme('Pick Your Taco Night', 'Pick your taco night.', [
    ['Beef Taco', 'Chicken Taco'], ['Fish Taco', 'Shrimp Taco'], ['Carnitas Taco', 'Barbecue Taco'],
    ['Breakfast Taco', 'Avocado Taco'], ['Crispy Taco', 'Soft Taco'], ['Cheeseburger Taco', 'Pizza Taco'],
    ['Bacon Taco', 'Sausage Taco'], ['Potato Taco', 'Falafel Taco'], ['Lobster Taco', 'Salmon Taco'],
  ]),
  theme('Build Your Burger Bar', 'Build your burger bar.', [
    ['Cheeseburger', 'Bacon Burger'], ['Chicken Burger', 'Salmon Burger'], ['Mushroom Burger', 'Avocado Burger'],
    ['BBQ Burger', 'Chili Burger'], ['Pizza Burger', 'Taco Burger'], ['Breakfast Burger', 'Sausage Burger'],
    ['Garlic Burger', 'Truffle Burger'], ['Macaroni Burger', 'Meatball Burger'], ['Falafel Burger', 'Shrimp Burger'],
  ]),
  theme('Choose Your Pasta Night', 'Choose your pasta night.', [
    ['Spaghetti', 'Lasagna'], ['Fettuccine Alfredo', 'Pesto Pasta'], ['Macaroni', 'Gnocchi'],
    ['Cheese Ravioli', 'Meatball Pasta'], ['Salmon Pasta', 'Shrimp Pasta'], ['Chicken Parmesan', 'Garlic Pasta'],
    ['Mushroom Risotto', 'Lobster Risotto'], ['Bacon Pasta', 'Sausage Pasta'], ['Tomato Pasta', 'Avocado Pasta'],
  ]),
  theme('Fill Your Sushi Platter', 'Fill your sushi platter.', [
    ['Salmon Sushi', 'Tuna Sushi'], ['Shrimp Sushi', 'Lobster Sushi'], ['Avocado Sushi', 'Cucumber Sushi'],
    ['Bacon Sushi', 'Chicken Sushi'], ['Mango Sushi', 'Orange Sushi'], ['Spicy Sushi', 'Tempura Sushi'],
    ['Egg Sushi', 'Tofu Sushi'], ['Crab Sushi', 'Eel Sushi'], ['Steak Sushi', 'Scallop Sushi'],
  ]),
  theme('Fill Your Bakery Box', 'Fill your bakery box.', [
    ['Butter Croissant', 'Almond Croissant'], ['Blueberry Muffin', 'Banana Muffin'], ['Chocolate Donut', 'Glazed Donut'],
    ['Cinnamon Roll', 'Danish'], ['Apple Pastry', 'Peach Pastry'], ['Baguette', 'Cornbread'],
    ['Chocolate Cake', 'Carrot Cake'], ['Macarons', 'Cannoli'], ['Garlic Bread', 'Banana Bread'],
  ]),
  theme('Visit The Ice Cream Shop', 'Visit the ice cream shop.', [
    ['Vanilla Ice Cream', 'Chocolate Ice Cream'], ['Strawberry Ice Cream', 'Mango Ice Cream'], ['Coffee Ice Cream', 'Caramel Ice Cream'],
    ['Mint Ice Cream', 'Pistachio Ice Cream'], ['Cookie Ice Cream', 'Brownie Ice Cream'], ['Banana Ice Cream', 'Peach Ice Cream'],
    ['Coconut Ice Cream', 'Avocado Ice Cream'], ['Cheesecake Ice Cream', 'Tiramisu Ice Cream'], ['Churro Ice Cream', 'Donut Ice Cream'],
  ]),
  theme('Pick Your Movie Snacks', 'Pick your movie snacks.', [
    ['Butter Popcorn', 'Caramel Popcorn'], ['Loaded Nachos', 'Potato Chips'], ['Soft Pretzel', 'Onion Rings'],
    ['Mozzarella Sticks', 'Chicken Nuggets'], ['Chocolate Candy', 'Peanut Butter Cups'], ['Mini Pizza', 'Mini Tacos'],
    ['Brownies', 'Cupcakes'], ['Soda', 'Lemonade'], ['Cookies', 'Ice Cream'],
  ]),
  theme('Build Your Game Day Spread', 'Build your game day spread.', [
    ['Buffalo Wings', 'Chicken Tenders'], ['Loaded Nachos', 'Chili Fries'], ['Mini Cheeseburgers', 'Hot Dog'],
    ['Pepperoni Pizza', 'Chicken Pizza'], ['Soft Pretzels', 'Potato Chips'], ['BBQ Chicken', 'Fried Chicken'],
    ['Taco Salad', 'Chicken Salad'], ['Garlic Bread', 'Mozzarella Sticks'], ['Brownies', 'Chocolate Cake'],
  ]),
  theme('Build Your Backyard Barbecue', 'Build your backyard barbecue.', [
    ['BBQ Chicken', 'Grilled Chicken'], ['BBQ Sausage', 'Hot Dog'], ['Cheeseburgers', 'Mushroom Burgers'],
    ['Grilled Salmon', 'Grilled Shrimp'], ['Potato Salad', 'Pasta Salad'], ['Cornbread', 'Biscuits'],
    ['Mac and Cheese', 'Mashed Potatoes'], ['Grilled Steak', 'Chicken Wings'], ['Peach Cobbler', 'Apple Pie'],
  ]),
  theme('Pack Your Picnic Basket', 'Pack your picnic basket.', [
    ['Club Sandwich', 'Tuna Sandwich'], ['Chicken Wrap', 'Falafel Wrap'], ['Fruit Salad', 'Avocado Salad'],
    ['Baguette', 'Croissants'], ['Potato Chips', 'Popcorn'], ['Lemonade', 'Iced Tea'],
    ['Brownies', 'Macarons'], ['Apple Pie', 'Carrot Cake'], ['Yogurt', 'Granola'],
  ]),
  theme('Build Your Holiday Feast', 'Build your holiday feast.', [
    ['Roast Chicken', 'Beef Wellington'], ['Mashed Potatoes', 'Sweet Potato Casserole'], ['Mac and Cheese', 'Cornbread'],
    ['Garlic Bread', 'Biscuits'], ['Green Salad', 'Caesar Salad'], ['Apple Pie', 'Pumpkin Pie'],
    ['Carrot Cake', 'Cheesecake'], ['Shrimp', 'Lobster'], ['Hot Chocolate', 'Coffee'],
  ]),
  theme('Choose Your Coffee Shop Order', 'Choose your coffee shop order.', [
    ['Espresso', 'Cappuccino'], ['Vanilla Latte', 'Caramel Latte'], ['Iced Coffee', 'Chai Tea'],
    ['Hot Chocolate', 'Matcha Latte'], ['Croissant', 'Blueberry Muffin'], ['Cinnamon Roll', 'Chocolate Donut'],
    ['Banana Bread', 'Carrot Cake'], ['Cannoli', 'Tiramisu'], ['Smoothie', 'Lemonade'],
  ]),
  theme('Mix Your Smoothie Bar', 'Mix your smoothie bar.', [
    ['Strawberry Smoothie', 'Mango Smoothie'], ['Banana Smoothie', 'Peach Smoothie'], ['Blueberry Smoothie', 'Raspberry Smoothie'],
    ['Avocado Smoothie', 'Coconut Smoothie'], ['Orange Smoothie', 'Apple Smoothie'], ['Chocolate Smoothie', 'Coffee Smoothie'],
    ['Yogurt Smoothie', 'Granola Smoothie'], ['Peanut Butter Smoothie', 'Cinnamon Smoothie'], ['Pineapple Smoothie', 'Watermelon Smoothie'],
  ]),
  theme('Choose Your Soup Season', 'Choose your soup season.', [
    ['Tomato Soup', 'Chicken Soup'], ['Potato Soup', 'Mushroom Soup'], ['Lobster Soup', 'Shrimp Soup'],
    ['Ramen', 'Noodle Soup'], ['Chili', 'Beef Stew'], ['Clam Chowder', 'Corn Soup'],
    ['Curry Soup', 'Coconut Soup'], ['Meatball Soup', 'Sausage Soup'], ['Garlic Soup', 'Avocado Soup'],
  ]),
  theme('Build Your Salad Bowl', 'Build your salad bowl.', [
    ['Caesar Salad', 'Greek Salad'], ['Chicken Salad', 'Tuna Salad'], ['Fruit Salad', 'Apple Salad'],
    ['Potato Salad', 'Macaroni Salad'], ['Salmon Salad', 'Shrimp Salad'], ['Taco Salad', 'Cobb Salad'],
    ['Egg Salad', 'Bacon Salad'], ['Couscous Salad', 'Rice Salad'], ['Lobster Salad', 'Steak Salad'],
  ]),
  theme('Choose Your Seafood Feast', 'Choose your seafood feast.', [
    ['Grilled Salmon', 'Fried Fish'], ['Shrimp', 'Lobster Roll'], ['Fish and Chips', 'Shrimp and Chips'],
    ['Salmon Sushi', 'Shrimp Sushi'], ['Lobster Ravioli', 'Shrimp Ravioli'], ['Fish Taco', 'Lobster Taco'],
    ['Seafood Rice', 'Seafood Pasta'], ['Salmon Burger', 'Shrimp Burger'], ['Ceviche', 'Crab Salad'],
  ]),
  theme('Choose Your Chicken Dinner', 'Choose your chicken dinner.', [
    ['Fried Chicken', 'Roast Chicken'], ['Chicken Wings', 'Chicken Tenders'], ['Chicken Parmesan', 'Chicken Alfredo'],
    ['Chicken Sandwich', 'Chicken Wrap'], ['Chicken Curry', 'Chicken Chili'], ['Chicken Salad', 'Chicken Soup'],
    ['Chicken Pizza', 'Chicken Taco'], ['Chicken Burger', 'Chicken Quesadilla'], ['Chicken and Waffles', 'Chicken and Biscuits'],
  ]),
  theme('Build Your Potato Party', 'Build your potato party.', [
    ['French Fries', 'Sweet Potato Fries'], ['Mashed Potatoes', 'Roast Potatoes'], ['Potato Salad', 'Potato Soup'],
    ['Potato Chips', 'Tater Tots'], ['Loaded Fries', 'Chili Fries'], ['Potato Casserole', 'Potato Pie'],
    ['Potato Pancakes', 'Potato Waffles'], ['Potato Bread', 'Potato Biscuits'], ['Potato Tacos', 'Potato Burritos'],
  ]),
  theme('Choose Your Sandwich Shop', 'Choose your sandwich shop.', [
    ['Grilled Cheese', 'Club Sandwich'], ['Chicken Sandwich', 'Tuna Sandwich'], ['Meatball Sandwich', 'Sausage Sandwich'],
    ['Lobster Roll', 'Shrimp Roll'], ['Breakfast Sandwich', 'Bagel Sandwich'], ['Steak Sandwich', 'Cheeseburger'],
    ['Falafel Sandwich', 'Avocado Sandwich'], ['Bacon Sandwich', 'Egg Sandwich'], ['Salmon Sandwich', 'Fish Sandwich'],
  ]),
  theme('Tour The Street Food Stalls', 'Tour the street food stalls.', [
    ['Tacos', 'Tamales'], ['Gyros', 'Falafel'], ['Bao', 'Dumplings'],
    ['Arepas', 'Tostadas'], ['Kebabs', 'Spring Rolls'], ['Churros', 'Donuts'],
    ['Pizza', 'Calzone'], ['Burritos', 'Quesadillas'], ['Hot Dog', 'Sausages'],
  ]),
  theme('Fill Your Mediterranean Table', 'Fill your Mediterranean table.', [
    ['Hummus', 'Falafel'], ['Chicken Gyro', 'Beef Kebab'], ['Couscous', 'Risotto'],
    ['Greek Salad', 'Antipasto'], ['Pita Bread', 'Garlic Bread'], ['Feta Pizza', 'Olive Pizza'],
    ['Salmon', 'Shrimp'], ['Tomato Pasta', 'Olive Pasta'], ['Baklava', 'Yogurt'],
  ]),
  theme('Build Your Indian Feast', 'Build your Indian feast.', [
    ['Tandoori Chicken', 'Butter Chicken'], ['Chicken Curry', 'Fish Curry'], ['Coconut Curry', 'Potato Curry'],
    ['Basmati Rice', 'Fried Rice'], ['Curry Rice', 'Curry Noodles'], ['Rice Pudding', 'Yogurt'],
    ['Mango Smoothie', 'Spiced Tea'], ['Lentil Soup', 'Chicken Soup'], ['Cauliflower Curry', 'Egg Curry'],
  ]),
  theme('Choose Your Southern Supper', 'Choose your southern supper.', [
    ['Fried Chicken', 'Chicken and Waffles'], ['Mac and Cheese', 'Sweet Potato Casserole'], ['Buttermilk Biscuits', 'Sweet Cornbread'],
    ['Meatloaf', 'Chicken Casserole'], ['Fried Shrimp', 'Fried Fish'], ['Peach Cobbler', 'Banana Pudding'],
    ['Sweet Tea', 'Lemonade'], ['Bacon Cornbread', 'Sausage Biscuits'], ['Apple Cobbler', 'Pecan Pie'],
  ]),
  theme('Pack Your Lunchbox', 'Pack your lunchbox.', [
    ['Peanut Butter Sandwich', 'Tuna Sandwich'], ['Chicken Wrap', 'Turkey Sandwich'], ['Apple', 'Banana'],
    ['Yogurt', 'Fruit Parfait'], ['Potato Chips', 'Cheese Pretzels'], ['Chocolate Cookies', 'Vanilla Cupcakes'],
    ['Pasta Salad', 'Fruit Salad'], ['Lemonade', 'Orange Smoothie'], ['Muffin', 'Brownie'],
  ]),
  theme('Fill Your Chocolate Box', 'Fill your chocolate box.', [
    ['Chocolate Truffles', 'Chocolate Candy'], ['Chocolate Cake', 'Chocolate Cheesecake'], ['Chocolate Brownies', 'Chocolate Cookies'],
    ['Chocolate Cupcake', 'Chocolate Donut'], ['Chocolate Ice Cream', 'Chocolate Gelato'], ['Chocolate Pudding', 'Chocolate Custard'],
    ['Chocolate Croissant', 'Chocolate Danish'], ['Chocolate Muffin', 'Chocolate Cinnamon Roll'], ['Chocolate Macarons', 'Chocolate Cannoli'],
  ]),
  theme('Build Your Waffle Bar', 'Build your waffle bar.', [
    ['Belgian Waffles', 'Buttermilk Waffles'], ['Chocolate Waffles', 'Vanilla Waffles'], ['Strawberry Waffles', 'Blueberry Waffles'],
    ['Banana Waffles', 'Peach Waffles'], ['Bacon Waffles', 'Sausage Waffles'], ['Chicken and Waffles', 'Ice Cream Waffles'],
    ['Cinnamon Waffles', 'Caramel Waffles'], ['Apple Waffles', 'Pumpkin Waffles'], ['Peanut Butter Waffles', 'Coffee Waffles'],
  ]),
  theme('Build Your Burrito', 'Build your burrito.', [
    ['Beef Burrito', 'Chicken Burrito'], ['Shrimp Burrito', 'Fish Burrito'], ['Breakfast Burrito', 'Bacon Burrito'],
    ['Potato Burrito', 'Rice Burrito'], ['Chili Burrito', 'Curry Burrito'], ['Cheeseburger Burrito', 'Pizza Burrito'],
    ['Avocado Burrito', 'Falafel Burrito'], ['Sausage Burrito', 'Meatball Burrito'], ['Lobster Burrito', 'Salmon Burrito'],
  ]),
  theme('Choose Your Cake Table', 'Choose your cake table.', [
    ['Chocolate Cake', 'Vanilla Cake'], ['Carrot Cake', 'Tiramisu Cake'], ['Strawberry Cake', 'Blueberry Cake'],
    ['Apple Cake', 'Banana Cake'], ['Coffee Cake', 'Cinnamon Cake'], ['Orange Cake', 'Lemon Cake'],
    ['Coconut Cake', 'Pistachio Cake'], ['Peach Cake', 'Mango Cake'], ['Cookie Cake', 'Brownie Cake'],
  ]),
  theme('Fill Your Snack Board', 'Fill your snack board.', [
    ['Potato Chips', 'Pretzels'], ['Popcorn', 'Nachos'], ['Hummus', 'Guacamole'],
    ['Chicken Nuggets', 'Chicken Tenders'], ['Onion Rings', 'Sweet Potato Fries'], ['Mini Tacos', 'Mini Cheeseburgers'],
    ['Cookies', 'Chocolate Cupcakes'], ['Fruit Salad', 'Yogurt'], ['Candy', 'Peanut Butter Cups'],
  ]),
]);

export const validateFoodTheme = (value, minimumQuestions = 7) => {
  const reasons = [];
  const title = String(value?.title || '').trim();
  const hookTtsText = String(value?.hookTtsText || '').trim();
  const themeKey = canonicalFoodThemeKey(title);
  if (!themeKey) reasons.push('theme title must contain meaningful words');
  if (!title || title.length > 42) reasons.push('theme title must be 1-42 characters');
  if (!hookTtsText || hookTtsText.length > 90) reasons.push('hook TTS must be 1-90 characters');
  if (!Array.isArray(value?.questions) || value.questions.length < minimumQuestions) reasons.push(`theme must contain at least ${minimumQuestions} questions`);
  return { valid: reasons.length === 0, reasons, themeKey, title, hookTtsText };
};
