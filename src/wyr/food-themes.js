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
    ['Mac and Cheese', 'Grilled Cheese'], ['Chicken Pot Pie', 'Beef Casserole'], ['Mashed Potatoes', 'French Fries'],
    ['Pizza', 'Lasagna'], ['Ramen', 'Tomato Soup'], ['Pot Roast', 'Cottage Pie'],
    ['Baked Ziti', 'Stuffed Peppers'], ['Meatloaf', 'Casserole'], ['Chili', 'Stew'],
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
    ['Lemon Tart', 'Chocolate Eclair'], ['Macarons', 'Cannoli'], ['Sourdough', 'Focaccia'],
  ]),
  theme('Visit The Ice Cream Shop', 'Visit the ice cream shop.', [
    ['Vanilla Ice Cream', 'Chocolate Ice Cream'], ['Strawberry Ice Cream', 'Mango Ice Cream'], ['Coffee Ice Cream', 'Caramel Ice Cream'],
    ['Mint Ice Cream', 'Pistachio Ice Cream'], ['Cookie Ice Cream', 'Brownie Ice Cream'], ['Banana Ice Cream', 'Peach Ice Cream'],
    ['Coconut Ice Cream', 'Avocado Ice Cream'], ['Cheesecake Ice Cream', 'Tiramisu Ice Cream'], ['Churro Ice Cream', 'Donut Ice Cream'],
  ]),
  theme('Pick Your Movie Snacks', 'Pick your movie snacks.', [
    ['Butter Popcorn', 'Caramel Popcorn'], ['Cheese Fries', 'Pizza Bites'], ['Sausage Roll', 'Calzone'],
    ['Mozzarella Sticks', 'Curly Fries'], ['Gummy Bears', 'Chocolate Raisins'], ['Corn Dogs', 'Ice Cream Bars'],
    ['Fudge', 'Jelly Beans'], ['Cola', 'Slushie'], ['Licorice', 'Chocolate Bar'],
  ]),
  theme('Build Your Game Day Spread', 'Build your game day spread.', [
    ['Potato Skins', 'Jalapeno Poppers'], ['Loaded Nachos', 'Chili Fries'], ['Mini Cheeseburgers', 'Hot Dog'],
    ['Pepperoni Pizza', 'Chicken Pizza'], ['Quesadillas', 'Fried Pickles'], ['BBQ Chicken', 'Smoked Turkey'],
    ['Taco Salad', 'Chicken Salad'], ['Spinach Dip', 'Queso Dip'], ['Churros', 'Ice Cream Sandwiches'],
  ]),
  theme('Build Your Backyard Barbecue', 'Build your backyard barbecue.', [
    ['BBQ Chicken', 'Grilled Chicken'], ['Pork Ribs', 'Lamb Chops'], ['Pulled Pork', 'Beef Brisket'],
    ['Grilled Salmon', 'Grilled Shrimp'], ['Potato Salad', 'Pasta Salad'], ['Cornbread', 'Biscuits'],
    ['Baked Beans', 'Coleslaw'], ['Grilled Steak', 'Chicken Wings'], ['Peach Cobbler', 'Apple Pie'],
  ]),
  theme('Pack Your Picnic Basket', 'Pack your picnic basket.', [
    ['Club Sandwich', 'Tuna Sandwich'], ['Chicken Wrap', 'Falafel Wrap'], ['Fruit Salad', 'Avocado Salad'],
    ['Baguette', 'Croissants'], ['Trail Mix', 'Cheese Crackers'], ['Lemonade', 'Iced Tea'],
    ['Scones', 'Shortbread'], ['Apple Turnover', 'Lemon Bars'], ['Brie', 'Strawberries'],
  ]),
  theme('Build Your Holiday Feast', 'Build your holiday feast.', [
    ['Roast Chicken', 'Beef Wellington'], ['Mashed Potatoes', 'Sweet Potato Casserole'], ['Stuffing', 'Green Bean Casserole'],
    ['Dinner Rolls', 'Yorkshire Pudding'], ['Green Salad', 'Caesar Salad'], ['Apple Pie', 'Pumpkin Pie'],
    ['Christmas Pudding', 'Yule Log'], ['Shrimp', 'Lobster'], ['Hot Chocolate', 'Coffee'],
  ]),
  theme('Choose Your Coffee Shop Order', 'Choose your coffee shop order.', [
    ['Espresso', 'Cappuccino'], ['Vanilla Latte', 'Caramel Latte'], ['Iced Coffee', 'Chai Tea'],
    ['Hot Chocolate', 'Matcha Latte'], ['Lemon Muffin', 'Chocolate Croissant'], ['Cinnamon Roll', 'Chocolate Donut'],
    ['Lemon Loaf', 'Pound Cake'], ['Fruit Danish', 'Vanilla Donut'], ['Iced Matcha', 'Milkshake'],
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
    ['French Fries', 'Sweet Potato Fries'], ['Baked Potatoes', 'Roast Potatoes'], ['Potato Salad', 'Potato Soup'],
    ['Potato Chips', 'Tater Tots'], ['Hash Browns', 'Potato Wedges'], ['Potato Casserole', 'Potato Pie'],
    ['Potato Pancakes', 'Potato Waffles'], ['Potato Bread', 'Potato Biscuits'], ['Potato Tacos', 'Potato Burritos'],
  ]),
  theme('Choose Your Sandwich Shop', 'Choose your sandwich shop.', [
    ['Grilled Cheese', 'Club Sandwich'], ['Chicken Sandwich', 'Tuna Sandwich'], ['Meatball Sandwich', 'Sausage Sandwich'],
    ['Pastrami Sandwich', 'Roast Beef Sandwich'], ['Breakfast Sandwich', 'Bagel Sandwich'], ['Steak Sandwich', 'Cheeseburger'],
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
    ['Salmon', 'Shrimp'], ['Tomato Pasta', 'Olive Pasta'], ['Baklava', 'Fig Tart'],
  ]),
  theme('Build Your Indian Feast', 'Build your Indian feast.', [
    ['Tandoori Chicken', 'Butter Chicken'], ['Chicken Curry', 'Fish Curry'], ['Coconut Curry', 'Potato Curry'],
    ['Basmati Rice', 'Fried Rice'], ['Curry Rice', 'Curry Noodles'], ['Rice Pudding', 'Gulab Jamun'],
    ['Mango Smoothie', 'Spiced Tea'], ['Lentil Soup', 'Chicken Soup'], ['Cauliflower Curry', 'Egg Curry'],
  ]),
  theme('Choose Your Southern Supper', 'Choose your southern supper.', [
    ['Fried Chicken', 'Chicken and Waffles'], ['Mac and Cheese', 'Sweet Potato Casserole'], ['Buttermilk Biscuits', 'Sweet Cornbread'],
    ['Meatloaf', 'Chicken Casserole'], ['Fried Shrimp', 'Fried Fish'], ['Peach Cobbler', 'Banana Pudding'],
    ['Sweet Tea', 'Lemonade'], ['Bacon Cornbread', 'Sausage Biscuits'], ['Apple Cobbler', 'Pecan Pie'],
  ]),
  theme('Pack Your Lunchbox', 'Pack your lunchbox.', [
    ['Peanut Butter Sandwich', 'Tuna Sandwich'], ['Ham Sandwich', 'Cheese Sandwich'], ['Apple', 'Banana'],
    ['Applesauce', 'Fruit Cup'], ['Crackers', 'Cheese Cubes'], ['Rice Cakes', 'Granola Bar'],
    ['Pasta Salad', 'Fruit Salad'], ['Apple Juice', 'Chocolate Milk'], ['Muffin', 'Banana Bread'],
  ]),
  theme('Fill Your Chocolate Box', 'Fill your chocolate box.', [
    ['Chocolate Truffles', 'Chocolate Candy'], ['Chocolate Cake', 'Chocolate Cheesecake'], ['Chocolate Brownies', 'Chocolate Cookies'],
    ['Chocolate Cupcake', 'Chocolate Donut'], ['Chocolate Fudge', 'Chocolate Toffee'], ['Chocolate Pudding', 'Chocolate Custard'],
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
    ['Cookies', 'Chocolate Cupcakes'], ['Mixed Nuts', 'Dried Fruit'], ['Candy', 'Peanut Butter Cups'],
  ]),
]);

const IRREGULAR_FOOD_PLURALS = new Map([
  ['brownies', 'brownie'], ['cookies', 'cookie'], ['pies', 'pie'], ['smoothies', 'smoothie'],
]);
const singularizeFoodWord = word => {
  if (IRREGULAR_FOOD_PLURALS.has(word)) return IRREGULAR_FOOD_PLURALS.get(word);
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith('oes') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('s') && word.length > 3 && !word.endsWith('ss') && !word.endsWith('us') && !word.endsWith('is')) return word.slice(0, -1);
  return word;
};

// Reporting normalization intentionally goes beyond the database's exact dedupe key: punctuation,
// capitalization, simple singular/plural variants, and A/B order should not hide repeated content.
export const normalizeFoodOption = value => normalize(value).split(' ').filter(Boolean).map(singularizeFoodWord).join(' ');
const normalizedFoodPair = question => [normalizeFoodOption(question?.optionA?.text), normalizeFoodOption(question?.optionB?.text)];
const unorderedPairKey = pair => [...pair].sort().join('|');
const pairWords = pair => new Set(pair.flatMap(value => value.split(' ')).filter(Boolean));
const jaccard = (left, right) => {
  const intersection = [...left].filter(word => right.has(word)).length;
  const union = new Set([...left, ...right]).size;
  return union ? intersection / union : 0;
};

export const auditFoodThemeContent = (themes = FOOD_THEME_SEEDS, { nearDuplicateThreshold = 0.75, questionsPerVideo = 7 } = {}) => {
  const pairs = themes.flatMap(themeValue => themeValue.questions.map((questionValue, index) => {
    const normalizedOptions = normalizedFoodPair(questionValue);
    return {
      themeKey: themeValue.themeKey,
      themeTitle: themeValue.title,
      questionIndex: index + 1,
      optionA: questionValue.optionA.text,
      optionB: questionValue.optionB.text,
      normalizedOptions,
      pairKey: unorderedPairKey(normalizedOptions),
      words: pairWords(normalizedOptions),
    };
  }));

  const optionCounts = new Map();
  for (const pair of pairs) for (const optionValue of pair.normalizedOptions) {
    const current = optionCounts.get(optionValue) || { option: optionValue, count: 0, themes: new Set() };
    current.count += 1; current.themes.add(pair.themeTitle); optionCounts.set(optionValue, current);
  }
  const optionFrequency = [...optionCounts.values()]
    .map(item => ({ option: item.option, count: item.count, themes: [...item.themes].sort() }))
    .sort((left, right) => right.count - left.count || left.option.localeCompare(right.option));

  const themeOptions = themes.map(themeValue => ({
    title: themeValue.title,
    options: new Set(themeValue.questions.flatMap(questionValue => normalizedFoodPair(questionValue))),
  }));
  const crossThemeOptionOverlap = [];
  for (let leftIndex = 0; leftIndex < themeOptions.length; leftIndex += 1) for (let rightIndex = leftIndex + 1; rightIndex < themeOptions.length; rightIndex += 1) {
    const left = themeOptions[leftIndex]; const right = themeOptions[rightIndex];
    const sharedOptions = [...left.options].filter(optionValue => right.options.has(optionValue)).sort();
    if (sharedOptions.length) crossThemeOptionOverlap.push({ leftTheme: left.title, rightTheme: right.title, count: sharedOptions.length, sharedOptions });
  }
  crossThemeOptionOverlap.sort((left, right) => right.count - left.count || left.leftTheme.localeCompare(right.leftTheme) || left.rightTheme.localeCompare(right.rightTheme));

  const exactDuplicates = []; const reversedDuplicates = []; const nearDuplicatePairs = [];
  const firstByPairKey = new Map();
  for (const pair of pairs) {
    const prior = firstByPairKey.get(pair.pairKey);
    if (prior) {
      const target = prior.normalizedOptions[0] === pair.normalizedOptions[0] && prior.normalizedOptions[1] === pair.normalizedOptions[1] ? exactDuplicates : reversedDuplicates;
      target.push({ first: prior, second: pair });
    } else firstByPairKey.set(pair.pairKey, pair);
  }
  for (let leftIndex = 0; leftIndex < pairs.length; leftIndex += 1) for (let rightIndex = leftIndex + 1; rightIndex < pairs.length; rightIndex += 1) {
    const left = pairs[leftIndex]; const right = pairs[rightIndex];
    if (left.pairKey === right.pairKey) continue;
    const similarity = jaccard(left.words, right.words);
    if (similarity >= nearDuplicateThreshold) nearDuplicatePairs.push({ similarity, first: left, second: right });
  }
  nearDuplicatePairs.sort((left, right) => right.similarity - left.similarity || left.first.themeTitle.localeCompare(right.first.themeTitle));

  return {
    themeCount: themes.length,
    totalPairs: pairs.length,
    uniqueNormalizedPairs: new Set(pairs.map(pair => pair.pairKey)).size,
    exactDuplicates,
    reversedDuplicates,
    nearDuplicatePairs,
    optionFrequency,
    crossThemeOptionOverlap,
    maximumCompleteVideos: themes.reduce((sum, themeValue) => sum + Math.floor(themeValue.questions.length / questionsPerVideo), 0),
  };
};

export const validateFoodThemeCollection = (themes = FOOD_THEME_SEEDS) => {
  const reasons = [];
  const themeKeys = new Set();
  for (const themeValue of themes) {
    const validation = validateFoodTheme(themeValue);
    if (!validation.valid) reasons.push(...validation.reasons.map(reason => `${themeValue?.title || 'Untitled theme'}: ${reason}`));
    if (themeKeys.has(validation.themeKey)) reasons.push(`duplicate normalized theme key: ${validation.themeKey}`);
    themeKeys.add(validation.themeKey);
  }
  const report = auditFoodThemeContent(themes);
  if (report.exactDuplicates.length) reasons.push(`${report.exactDuplicates.length} exact normalized pair duplicate(s)`);
  if (report.reversedDuplicates.length) reasons.push(`${report.reversedDuplicates.length} reversed normalized pair duplicate(s)`);
  if (report.nearDuplicatePairs.length) reasons.push(`${report.nearDuplicatePairs.length} near-duplicate pair(s)`);
  return { valid: reasons.length === 0, reasons, report };
};

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
