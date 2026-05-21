from ckanext.geoview import plugin, utils

def test_plugin():
    """This is here just as a sanity test
    """
    p = plugin.OLGeoView()
    assert p


def test_wcs_plugin():
    p = plugin.WCSView()
    assert p


def test_clean_query_string_removes_empty_key():
    query = b"=&SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0"

    assert (
        utils.clean_query_string(query)
        == "SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0"
    )


def test_clean_query_string_preserves_repeated_and_blank_values():
    query = "SUBSET=x(1,2)&SUBSET=y(3,4)&FORMAT="

    assert (
        utils.clean_query_string(query)
        == "SUBSET=x%281%2C2%29&SUBSET=y%283%2C4%29&FORMAT="
    )
