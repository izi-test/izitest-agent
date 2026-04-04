interface ElementList {
  type: string;
  parent: Element;
  elementIndex?: number;
  nbElements?: number;
  elementXpath?: string;
  childNodes?: Node[];
}

export default class FindSimilarElements {
  /**
   * Finds similar elements starting from a given element by traversing up the DOM to a certain level.
   * @param startElement - The starting element.
   * @param maxLevelsUp - The maximum number of levels to traverse up the DOM.
   * @returns An ElementList object containing information about similar elements, or null if none are found.
   */
  static getFrom(startElement: Element, maxLevelsUp: number): ElementList | null {
    // Checks if the starting element is an element node and is not an 'input' or 'select'.
    if (
      startElement.nodeType !== Node.ELEMENT_NODE ||
      ['input', 'select'].includes(startElement.tagName.toLowerCase())
    ) {
      return null;
    }

    let elementList: ElementList | null = null;
    let currentElement = startElement;
    let parentElement: Element | null = null;
    let elementXpath = this.getXpath(currentElement, true);
    const simpleElementXpath = this.getXpath(currentElement, false);
    let newXpath = elementXpath;

    // Traverse up the DOM levels up to the specified maximum level.
    for (let level = 0; level < maxLevelsUp; level++) {
      // Stops if the current element has no parent or if the parent is the 'body' element.
      if (
        !currentElement.parentElement ||
        currentElement.parentElement.tagName.toLowerCase() === 'body'
      ) {
        break;
      }

      const currentTagName = currentElement.tagName.toLowerCase();

      // Retrieves sibling elements with the same tag name as the current element.
      let siblingElements = Array.from(currentElement.parentElement.children).filter(
        (sibling) => sibling.tagName.toLowerCase() === currentTagName,
      );

      // Move to the parent element for the next level.
      currentElement = currentElement.parentElement;

      if (level === 0) {
        // For the first level, filter siblings with the same simple XPath.
        siblingElements = siblingElements.filter(
          (sibling) => this.getXpath(sibling, false) === simpleElementXpath,
        );

        const parentNodes = siblingElements.map((sibling) => sibling.parentElement!);
        const similarElements = this.getSimilarElements(parentNodes, simpleElementXpath, startElement);

        if (siblingElements.length > 2 && !this.checkIfBox(similarElements, simpleElementXpath)) {
          elementList = {
            type: 'list',
            parent: currentElement,
            elementIndex: similarElements.startElementIndex,
            nbElements: siblingElements.length,
            elementXpath: simpleElementXpath,
          };
          break;
        }
        continue;
      }

      const similarElements = this.getSimilarElements(siblingElements, elementXpath, startElement);

      if (similarElements.similarChildNodes.length > 2) {
        parentElement = currentElement;

        if (this.checkIfBox(similarElements, newXpath)) {
          elementList = {
            type: 'box',
            parent: similarElements.similarChildNodes[0] as Element,
            elementIndex: similarElements.startElementIndex,
            nbElements: similarElements.similarChildNodes.length,
            elementXpath: elementXpath,
            childNodes: similarElements.similarChildNodes,
          };
          break;
        }

        // Checks if similar elements have common text content.
        const textsInSnapshots = similarElements.snapshots.map((snapshot) =>
          snapshot.map((element) => element.textContent?.trim() || ''),
        );

        const hasCommonText = this.hasCommonElementInAllArrays(textsInSnapshots);

        if (hasCommonText) {
          const allTextsAreSame = similarElements.similarChildNodes.every(
            (element) =>
              element.textContent?.trim() === similarElements.similarChildNodes[0].textContent?.trim(),
          );

          if (!parentElement.textContent?.trim() || allTextsAreSame) {
            elementXpath = `${currentTagName}/${elementXpath}`;
            continue;
          }

          elementList = {
            type: 'box',
            parent: similarElements.similarChildNodes[0] as Element,
            elementIndex: similarElements.startElementIndex,
            nbElements: similarElements.similarChildNodes.length,
            elementXpath: elementXpath,
            childNodes: similarElements.similarChildNodes,
          };
        } else {
          newXpath = `${currentTagName}/${elementXpath}`;


          if (this.checkIfBox(similarElements, newXpath)) {
            elementXpath = newXpath;
            continue;
          }

          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          const similarChildTagName = similarElements.similarChildNodes[0].tagName.toLowerCase();

          elementList = {
            type: 'list',
            parent: parentElement,
            elementIndex: similarElements.startElementIndex,
            nbElements: similarElements.similarChildNodes.length,
            elementXpath: `${similarChildTagName}/${elementXpath.replace(
              /$begin:math:display$\\d+$end:math:display$$/,
              '',
            )}`,
          };
        }
        break;
      } else {
        elementXpath = `${currentTagName}/${elementXpath}`;
      }
    }

    return elementList;
  }

  /**
   * Checks if the similar elements form a "box" based on the XPath.
   * @param similarElements - Object containing snapshots and similar nodes.
   * @param elementXpath - The XPath of the element.
   * @returns True if it is a box, false otherwise.
   */
  private static checkIfBox(
    similarElements: { snapshots: Node[][]; similarChildNodes: Node[] },
    elementXpath: string,
  ): boolean {
    const firstSnapshotItems = similarElements.snapshots[0];

    return similarElements.similarChildNodes.every((element) => {
      return firstSnapshotItems.some((snapshotItem) => {
        const xpath = `${elementXpath}[normalize-space()="${snapshotItem.textContent?.trim()}"]`;
        const evaluatedElements = document.evaluate(
          `./${xpath}`,
          element,
          null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
          null,
        );
        return evaluatedElements.snapshotLength > 1;
      });
    });
  }

  /**
   * Generates the XPath of an element.
   * @param element - The element for which to generate the XPath.
   * @param includeOrder - Indicates whether to include the order of elements.
   * @returns The XPath of the element.
   */
  private static getXpath(element: Element, includeOrder = false): string {
    const tagName = element.tagName.toLowerCase();
    const className =
      element.className && typeof element.className === 'string'
        ? element.className.split(' ')[0]
        : '';
    const siblings = Array.from(element.parentElement?.children || []);

    if (className) {
      const sameClassSiblings = siblings.filter(
        (sibling) =>
          sibling.className === element.className && sibling.tagName === element.tagName,
      );

      if (sameClassSiblings.length > 1 && includeOrder) {
        const index = sameClassSiblings.indexOf(element) + 1; // XPath is 1-indexed
        return `${tagName}[contains(@class,'${className}')][${index}]`;
      } else {
        return `${tagName}[contains(@class,'${className}')]`;
      }
    } else {
      const sameTagSiblings = siblings.filter((sibling) => sibling.tagName === element.tagName);

      if (sameTagSiblings.length > 1 && includeOrder) {
        const index = sameTagSiblings.indexOf(element) + 1;
        return `${tagName}[${index}]`;
      } else {
        return tagName;
      }
    }
  }

  /**
   * Retrieves similar elements based on child nodes and XPath.
   * @param childNodes - The child nodes to examine.
   * @param elementXpath - The XPath of the element to compare.
   * @returns An object containing snapshots and similar child nodes.
   */
  private static getSimilarElements(childNodes: Node[], elementXpath: string, startElement: Element) {
    const snapshotItems: Node[][] = [];
    const similarChildNodes: Node[] = [];
    const allMatchingElements: Node[] = [];
    let startChildNode: Node = childNodes[0];

    childNodes.forEach((childNode) => {
      if (childNode.nodeType === 1 && this.isVisibleCSS(childNode as Element)) {
        const xpathExpression = elementXpath.startsWith('.')
          ? elementXpath
          : './/' + elementXpath;
        const elementbox = document.evaluate(
          xpathExpression,
          childNode,
          null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
          null,
        );
        if (elementbox.snapshotLength > 0) {
          const snapshots: Node[] = [];
          for (let i = 0; i < elementbox.snapshotLength; i++) {
            const item = elementbox.snapshotItem(i);
            if (item) {
              snapshots.push(item);
              allMatchingElements.push(item);

              // Vérifier si l'élément trouvé est le startElement
              if (item === startElement || item.isSameNode(startElement)) {
                startChildNode = childNode;
              }
            }
          }
          snapshotItems.push(snapshots);
          similarChildNodes.push(childNode);
        }
      }
    });
    return {
      snapshots: snapshotItems,
      similarChildNodes: similarChildNodes,
      allMatchingElements: allMatchingElements,
      startElementIndex: similarChildNodes.indexOf(startChildNode),
    };
  }

  /**
   * Checks if there is a common element in all subarrays.
   * @param arrays - Array of arrays to check.
   * @returns True if a common element is present in all subarrays, false otherwise.
   */
  private static hasCommonElementInAllArrays(arrays: string[][]): boolean {
    const allElements = new Set(arrays.flat());

    // for each element in the set, check if it is present in more than one subarray
    for (const element of allElements) {
      if (arrays.filter((subArray) => subArray.includes(element)).length > 1) {
        return true;
      }
    }

    // for (const element of allElements) {
    //   if (arrays.every((subArray) => subArray.includes(element))) {
    //     return true;
    //   }
    // }
    return false;
  }

  /**
   * Checks if an element is visible according to CSS.
   * @param element - The element to check.
   * @returns True if the element is visible, false otherwise.
   */
  private static isVisibleCSS(element: Element): boolean {
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }
}