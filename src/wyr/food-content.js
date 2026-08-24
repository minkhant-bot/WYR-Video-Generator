// FOOD mode is intentionally narrower than the database's historical `food` category. The pool
// contains legacy lifestyle/scenario prompts, so category alone is not a render-safety boundary.
// This validator accepts concise, photographable food entities and rejects instructions,
// experiences, people, places, professions, ownership and hypothetical conditions.

const FOOD_HEADS = new Set(`
  aioli alfredo ambrosia antipasto apple apples arepa arepas avocado avocados bacon bagel bagels baguette baklava banana bananas bao barbecue bbq
  biscuit biscuits boba brownie brownies burger burgers burrito burritos cake cakes calzone calzones
  bread breads butter candy cannoli casserole cereal ceviche cheeseburger cheeseburgers cheesecake cheesecakes chicken
  chili chips churro churros cobbler coffee cookie cookies cornbread couscous croissant croissants
  cream cupcake cupcakes curry custard danish dimsum donut donuts doughnut doughnuts dumpling dumplings
  egg eggs falafel fish fries frittata fruit gelato gnocchi granola gravy guacamole gyro gyros hashbrowns hummus icecream
  jam jambalaya kebab kebabs lasagna lemonade lobster macaron macarons macaroni meatball meatballs meatloaf
  cappuccino cappuccinos cola espresso espressos latte lattes milk milkshake milkshakes muffin muffins nachos noodles omelet omelets omelette omelettes orange oranges pancake pancakes
  parfait pasta pastry pastries peach peaches pie pies pizza pizzas popcorn potato potatoes pretzel pretzels pudding quesadilla
  quesadillas ramen ravioli rice risotto roast roll rolls salad salads salmon salsa sandwich sandwiches sausage sausages shrimp
  smoothie smoothies soda soup soups spaghetti steak steaks stew sushi taco tacos tamale tamales tea
  tiramisu toast tostada tostadas truffle truffles waffle waffles water wings wrap wraps yogurt yoghurt
`.trim().split(/\s+/));

// Common multi-word dishes whose final token is not by itself a useful food head.
const EXACT_FOODS = new Set(`
  apple pie|banana bread|beef wellington|breakfast burrito|buffalo wings|caesar salad|carrot cake|
  chicken nuggets|chicken parmesan|chicken sandwich|chicken tenders|chicken wings|cinnamon roll|
  clam chowder|club sandwich|crème brûlée|creme brulee|eggs benedict|fish and chips|french fries|
  french toast|fried chicken|fried rice|fruit salad|garlic bread|grilled cheese|hot chocolate|hot dog|
  ice cream|key lime pie|mac and cheese|mashed potatoes|mozzarella sticks|onion rings|peanut butter cups|
  potato chips|rice pudding|roast chicken|shrimp cocktail|spring rolls|sweet potato fries|tater tots|
  tomato soup|tuna sandwich
`.replace(/\s*\|\s*/g, '|').trim().split('|'));

const FORBIDDEN_WORDS = new Set(`
  ability abilities all always bake baker bakers barista baristas bartender bartenders become becoming buy can chef chefs
  choose cook cooking cooks create cuisine cuisines dine dining eat eating experience experiences forever free
  gain get gets have having hire host hosting imaginary invisible job jobs keep learn lifestyle lifetime live living love loving magic magical make master mastering never only open order own owning
  personal person people prepare receive restaurant restaurants run running sell serve skill skills spend storefront storefronts taste trainer try
  teleporting truck trucks unlimited virtual visit waiter waiters waitress waitresses work year years you yourself
`.trim().split(/\s+/));

const ALCOHOL_WORDS = new Set('alcohol alcoholic beer beers bourbon champagne cocktail cocktails liquor martini rum tequila vodka whiskey whisky wine wines'.split(/\s+/));
const GENERIC_CONCEPTS = new Set('breakfast cuisine dessert desserts dinner drink drinks fastfood food lunch meal meals snack snacks streetfood'.split(/\s+/));
const CONNECTORS = new Set(['and', 'with']);

const normalize = value => String(value ?? '')
  .normalize('NFKC')
  .replace(/[’]/g, "'")
  .replace(/\s+/g, ' ')
  .trim();

const comparable = value => normalize(value).toLocaleLowerCase('en-US').replace(/-/g, ' ');
const wordsOf = value => comparable(value).match(/[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu) || [];

export const assessFoodEntityLabel = value => {
  const label = normalize(value);
  if (!label) return { valid: false, label, reason: 'empty option' };
  if (label.length > 55) return { valid: false, label, reason: 'food label exceeds 55 characters' };
  // Noun labels may contain letters, spaces, apostrophes, ampersands and hyphens, but not sentence
  // punctuation, quantities, slashes or parenthetical/editorial wording.
  if (!/^[\p{L}][\p{L}\p{M}'’& -]*$/u.test(label)) return { valid: false, label, reason: 'option is not a plain noun phrase' };
  const comparableLabel = comparable(label).replace(/\s*&\s*/g, ' and ');
  const words = wordsOf(comparableLabel);
  const semanticWords = words.map(word => word.replace(/'s$/u, ''));
  if (!words.length || words.length > 8) return { valid: false, label, reason: 'option is not a concise food noun phrase' };
  if (semanticWords.some(word => FORBIDDEN_WORDS.has(word))) return { valid: false, label, reason: 'option contains a scenario, action, person, place, profession, or ownership term' };
  if (semanticWords.some(word => ALCOHOL_WORDS.has(word))) return { valid: false, label, reason: 'alcohol is outside FOOD mode' };
  if (GENERIC_CONCEPTS.has(comparableLabel.replace(/\s+/g, ''))) return { valid: false, label, reason: 'option is an abstract food category rather than one food entity' };
  if (EXACT_FOODS.has(comparableLabel)) return { valid: true, label, literalFood: label };
  const contentWords = semanticWords.filter(word => !CONNECTORS.has(word));
  const head = contentWords.at(-1);
  if (!FOOD_HEADS.has(head)) return { valid: false, label, reason: 'option is not a recognized edible food or non-alcoholic drink' };
  return { valid: true, label, literalFood: label };
};

export const assessFoodPair = (optionA, optionB) => {
  const a = assessFoodEntityLabel(optionA);
  const b = assessFoodEntityLabel(optionB);
  return { valid: a.valid && b.valid, optionA: a, optionB: b };
};

export const assessFoodPoolRow = row => assessFoodPair(row?.option_a_text, row?.option_b_text);
export const isStrictFoodPoolRow = row => row?.category === 'food' && assessFoodPoolRow(row).valid;

export class InvalidFoodContentError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.code = 'INVALID_FOOD_CONTENT';
    Object.assign(this, details);
  }
}

export const assertStrictFoodPlan = plan => {
  const failures = [];
  for (const [index, question] of (plan?.questions || []).entries()) {
    const result = assessFoodPair(question?.optionA?.text, question?.optionB?.text);
    if (question?.category !== 'food' || !result.valid) failures.push({ index, category: question?.category, optionA: result.optionA, optionB: result.optionB });
  }
  if (!plan?.questions?.length || failures.length) {
    throw new InvalidFoodContentError(
      `FOOD_CONTENT_INVALID: ${failures.length || 1} question(s) failed the strict literal-food gate; rendering was stopped.`,
      { failures },
    );
  }
  return plan;
};
