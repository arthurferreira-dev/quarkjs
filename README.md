# QuarkJS

![Version Badge](https://img.shields.io/badge/Version-1.0%20(Demo)-red)
![NPM Version](https://img.shields.io/npm/v/:quark-js)

A language that is simple to understand, easy to use, and practical for building React applications. Its files use the `.jtx` extension (**`JavaScript Typed XML`**) and are compiled to `.jsx` or `.tsx`.

## Structure

QuarkJS uses just 2 modules: the **JTX** module and the **Builderman** module. The **JTX** module translates all the syntax and functions of `.jtx` files, while **Builderman** uses some of JTX's functions to build all `.jtx` files into `.jsx`/`.tsx`.

## Features

### `use` instead of `import`

```jtx
use { Heart } from "lucide-react"
```

Becomes:

```jsx
import { Heart } from "lucide-react";
```

### `default` instead of `export default function`

```jtx
default App() {
  return (
    <div>
      <Heart />
    </div>
  )
}
```

Becomes:

```jsx
export default function App() {
  return (
    <div>
      <Heart />
    </div>
  );
}
```

Without `default`, the function becomes a named export:

```jtx
App() {
  return (
    <div>
      <Heart />
    </div>
  )
}
```

Becomes:

```jsx
export function App() {
  return (
    <div>
      <Heart />
    </div>
  );
}
```

If you don't want a named export, use the `@no-export` decorator right above the function:

```jtx
@no-export
App() {
  return (
    <div>
      <Heart />
    </div>
  )
}
```

Becomes:

```jsx
function App() {
  return (
    <div>
      <Heart />
    </div>
  );
}
```

Features such as self-closing tags keep working normally.

## One-word hooks

| React hook       | JTX hook | How to use                  |
| ---------------- | -------- | --------------------------- |
| useState         | state    | state name, setName = value |
| useRef           | ref      | ref element = value         |
| useId            | id       | id name                     |
| useDeferredValue | deferred | deferred name = value       |
| useContext       | context  | context name = ThemeContext |

> **_Hooks such as useEffect and useMemo don't exist in JTX yet_**

## Native Features

### Shared State: `share`

`share` is an alternative to Zustand, letting you share any state natively, without installing dependencies, with just one word.

```jtx
share items, setItems = [] // any primitive type can be assigned to it
```

See the following example:

```jtx
@path="store/shared.js"
share items, setItems = false

@path="test/Test.jsx"
Test() {
  return (
    <div>
      <button onClick={() => setItems(!items)}>Has items?</button>
      <p>{items ? "There are items in the list!" : "There are no items in the list!"}</p>
    </div>
  );
}
```

`store/shared.js`:

```js
const items$store = { value: false, listeners: new Set() };
export const getItems = () => items$store.value;
export const setItems = (next) => {
  items$store.value =
    typeof next === "function" ? next(items$store.value) : next;
  items$store.listeners.forEach((listener) => listener());
};
export const useItems = () =>
  useSyncExternalStore(
    (listener) => {
      items$store.listeners.add(listener);
      return () => {
        items$store.listeners.delete(listener);
      };
    },
    getItems,
    getItems,
  );
```

`test/Test.jsx`:

```jsx
import { useItems, setItems } from "../store/shared";

export function Test() {
  const items = useItems();
  return (
    <div>
      <button onClick={() => setItems(!items)}>Has items?</button>
      <p>
        {items
          ? "There are items in the list!"
          : "There are no items in the list!"}
      </p>
    </div>
  );
}
```

### Variables used without exporting: `<variables></variables>`

When you place a JavaScript variable inside this block, the JTX module automatically handles the exports and imports for the React files that use it.

```jtx
<variables>
  const router = createBrowserRouter([...])
</variables>
```

Generates:

```jsx
import { createBrowserRouter } from "react-router-dom";

export const router = createBrowserRouter([...]);
```